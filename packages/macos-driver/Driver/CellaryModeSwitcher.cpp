/**
 * CellaryModeSwitcher -- universal DriverKit USB modem mode switch driver.
 *
 * A data-driven driver that reads the mode switch method and payload from
 * Info.plist personality properties. Adding a new device requires ZERO code
 * changes -- just add a personality to Info.plist with:
 *
 *   ModeSwitchMethod: "scsi-cbw" | "vendor-control"
 *   ModeSwitchData:   <data>...</data>  (raw CBW bytes for scsi-cbw)
 *   ControlRequest:   <integer>        (bRequest for vendor-control)
 *   ControlRequestType: <integer>      (bmRequestType for vendor-control)
 *   ControlValue:     <integer>        (wValue for vendor-control, default 0)
 *   ControlIndex:     <integer>        (wIndex for vendor-control, default 0)
 *
 * This solves a fundamental macOS limitation: IOUSBMassStorageDriver holds
 * exclusive access to storage-mode USB devices. By matching at the
 * IOUSBHostDevice level with a higher probe score, we claim the device
 * before the mass storage driver ever loads.
 */

#include <os/log.h>
#include <DriverKit/IOLib.h>
#include <DriverKit/IOBufferMemoryDescriptor.h>
#include <DriverKit/OSDictionary.h>
#include <DriverKit/OSString.h>
#include <DriverKit/OSData.h>
#include <DriverKit/OSNumber.h>
#include <USBDriverKit/IOUSBHostDevice.h>
#include <USBDriverKit/IOUSBHostInterface.h>
#include <USBDriverKit/IOUSBHostPipe.h>

#include "CellaryModeSwitcher.h"

// -- Constants ----------------------------------------------------------------

static const uint8_t USB_CLASS_MASS_STORAGE = 8;
static const uint32_t TRANSFER_TIMEOUT_MS = 5000;

// -- Logging ------------------------------------------------------------------

#define LOG_PREFIX "CellaryModeSwitcher"

#define CELLARY_LOG(fmt, ...) \
    os_log(OS_LOG_DEFAULT, LOG_PREFIX ": " fmt, ##__VA_ARGS__)

#define CELLARY_ERROR(fmt, ...) \
    os_log_error(OS_LOG_DEFAULT, LOG_PREFIX ": " fmt, ##__VA_ARGS__)

// -- Instance variables -------------------------------------------------------

struct CellaryModeSwitcher_IVars {
    IOUSBHostDevice *device;
    uint16_t vendorId;
    uint16_t productId;
};

// -- Helpers ------------------------------------------------------------------

/// Check if a return code indicates the device disconnected (expected after mode switch).
static bool isExpectedDisconnect(kern_return_t ret) {
    return ret == kIOReturnSuccess ||
           ret == kIOReturnAborted ||
           ret == kIOReturnNotResponding ||
           ret == kIOUSBPipeStalled;
}

// -- Lifecycle ----------------------------------------------------------------

bool CellaryModeSwitcher::init() {
    if (!super::init()) return false;

    ivars = IONewZero(CellaryModeSwitcher_IVars, 1);
    if (ivars == nullptr) return false;

    return true;
}

void IMPL(CellaryModeSwitcher, free) {
    if (ivars != nullptr) {
        IOSafeDeleteNULL(ivars, CellaryModeSwitcher_IVars, 1);
    }
    super::free();
}

kern_return_t IMPL(CellaryModeSwitcher, Start) {
    kern_return_t ret;

    ret = Start(provider, SUPERDISPATCH);
    if (ret != kIOReturnSuccess) {
        CELLARY_ERROR("super::Start failed: 0x%x", ret);
        return ret;
    }

    // Cast provider to IOUSBHostDevice
    ivars->device = OSDynamicCast(IOUSBHostDevice, provider);
    if (ivars->device == nullptr) {
        CELLARY_ERROR("provider is not IOUSBHostDevice");
        return kIOReturnNoDevice;
    }
    ivars->device->retain();

    // Read VID/PID from device descriptor
    const IOUSBDeviceDescriptor *desc = ivars->device->CopyDeviceDescriptor();
    if (desc == nullptr) {
        CELLARY_ERROR("CopyDeviceDescriptor failed");
        ivars->device->release();
        ivars->device = nullptr;
        return kIOReturnNoDevice;
    }
    ivars->vendorId = USBToHost16(desc->idVendor);
    ivars->productId = USBToHost16(desc->idProduct);
    IOUSBHostFreeDescriptor(desc);

    CELLARY_LOG("matched device %04x:%04x", ivars->vendorId, ivars->productId);

    // Read mode switch method from personality properties
    OSDictionary *properties = nullptr;
    ret = CopyProperties(&properties);
    if (ret != kIOReturnSuccess || properties == nullptr) {
        CELLARY_ERROR("CopyProperties failed: 0x%x", ret);
        ivars->device->release();
        ivars->device = nullptr;
        return kIOReturnError;
    }

    OSString *methodStr = OSDynamicCast(
        OSString, properties->getObject("ModeSwitchMethod")
    );
    if (methodStr == nullptr) {
        CELLARY_ERROR("no ModeSwitchMethod in personality");
        properties->release();
        ivars->device->release();
        ivars->device = nullptr;
        return kIOReturnBadArgument;
    }

    // Open the device
    ret = ivars->device->Open(this, 0, nullptr);
    if (ret != kIOReturnSuccess) {
        CELLARY_ERROR("device Open failed: 0x%x", ret);
        properties->release();
        ivars->device->release();
        ivars->device = nullptr;
        return ret;
    }

    // Dispatch based on method
    const char *method = methodStr->getCStringNoCopy();
    CELLARY_LOG("mode switch method: %s", method);

    if (strcmp(method, "scsi-cbw") == 0) {
        ret = executeScsiCbw(properties);
    } else if (strcmp(method, "vendor-control") == 0) {
        ret = executeVendorControl(properties);
    } else {
        CELLARY_ERROR("unknown ModeSwitchMethod: %s", method);
        ret = kIOReturnUnsupported;
    }

    // Cleanup
    properties->release();
    ivars->device->Close(this, 0);

    if (isExpectedDisconnect(ret)) {
        CELLARY_LOG("mode switch complete, device will re-enumerate");
    } else {
        CELLARY_LOG("mode switch returned 0x%x", ret);
    }

    RegisterService();
    return kIOReturnSuccess;
}

kern_return_t IMPL(CellaryModeSwitcher, Stop) {
    CELLARY_LOG("Stop: %04x:%04x", ivars->vendorId, ivars->productId);

    if (ivars->device != nullptr) {
        ivars->device->release();
        ivars->device = nullptr;
    }

    return Stop(provider, SUPERDISPATCH);
}

// -- SCSI CBW mode switch -----------------------------------------------------

kern_return_t CellaryModeSwitcher::executeScsiCbw(OSDictionary *properties) {
    // Read CBW payload from ModeSwitchData property
    OSData *cbwData = OSDynamicCast(OSData, properties->getObject("ModeSwitchData"));
    if (cbwData == nullptr || cbwData->getLength() == 0) {
        CELLARY_ERROR("scsi-cbw: no ModeSwitchData");
        return kIOReturnBadArgument;
    }

    const uint8_t *cbw = (const uint8_t *)cbwData->getBytesNoCopy();
    uint32_t cbwLength = cbwData->getLength();
    CELLARY_LOG("scsi-cbw: %u bytes", cbwLength);

    // Find mass storage interface
    IOUSBConfigurationDescriptor *configDesc = ivars->device->CopyConfigurationDescriptor(0);
    if (configDesc == nullptr) {
        CELLARY_ERROR("CopyConfigurationDescriptor failed");
        return kIOReturnError;
    }

    IOUSBInterfaceDescriptor *ifaceDesc = nullptr;
    while (true) {
        ifaceDesc = (IOUSBInterfaceDescriptor *)
            IOUSBGetNextAssociatedDescriptorWithType(
                configDesc, ifaceDesc, kIOUSBDescriptorTypeInterface
            );
        if (ifaceDesc == nullptr) break;
        if (ifaceDesc->bInterfaceClass == USB_CLASS_MASS_STORAGE) break;
    }

    if (ifaceDesc == nullptr) {
        IOUSBHostFreeDescriptor(configDesc);
        CELLARY_ERROR("no mass storage interface");
        return kIOReturnNotFound;
    }

    uint8_t ifaceNumber = ifaceDesc->bInterfaceNumber;
    IOUSBHostFreeDescriptor(configDesc);
    CELLARY_LOG("mass storage interface: %d", ifaceNumber);

    // Get interface object via iterator
    IOUSBHostInterface *iface = nullptr;
    uintptr_t iterator = 0;
    kern_return_t ret = ivars->device->CreateInterfaceIterator(&iterator);
    if (ret != kIOReturnSuccess) {
        CELLARY_ERROR("CreateInterfaceIterator failed: 0x%x", ret);
        return ret;
    }

    while (true) {
        IOUSBHostInterface *candidate = nullptr;
        ret = ivars->device->CopyInterface(iterator, &candidate);
        if (ret != kIOReturnSuccess || candidate == nullptr) break;

        const IOUSBInterfaceDescriptor *desc = candidate->GetInterfaceDescriptor(nullptr);
        if (desc != nullptr && desc->bInterfaceNumber == ifaceNumber) {
            iface = candidate;
            break;
        }
        candidate->release();
    }

    if (iface == nullptr) {
        CELLARY_ERROR("interface %d not found", ifaceNumber);
        return kIOReturnNotFound;
    }

    ret = iface->Open(this, 0, nullptr);
    if (ret != kIOReturnSuccess) {
        CELLARY_ERROR("interface Open failed: 0x%x", ret);
        iface->release();
        return ret;
    }

    // Find bulk OUT endpoint
    IOUSBHostPipe *outPipe = nullptr;
    const IOUSBInterfaceDescriptor *openDesc = iface->GetInterfaceDescriptor(nullptr);
    if (openDesc != nullptr) {
        IOUSBEndpointDescriptor *epDesc = nullptr;
        while (true) {
            epDesc = (IOUSBEndpointDescriptor *)
                IOUSBGetNextAssociatedDescriptorWithType(
                    openDesc, epDesc, kIOUSBDescriptorTypeEndpoint
                );
            if (epDesc == nullptr) break;

            uint8_t epType = epDesc->bmAttributes & 0x03;
            uint8_t epAddr = epDesc->bEndpointAddress;
            if (epType == kIOUSBEndpointTypeBulk && (epAddr & 0x80) == 0) {
                ret = iface->CopyPipe(epAddr, &outPipe);
                if (ret == kIOReturnSuccess) {
                    CELLARY_LOG("bulk OUT endpoint: 0x%02x", epAddr);
                    break;
                }
            }
        }
    }

    if (outPipe == nullptr) {
        CELLARY_ERROR("no bulk OUT endpoint");
        iface->Close(this, 0);
        iface->release();
        return kIOReturnNotFound;
    }

    // Create buffer, copy CBW, send
    IOBufferMemoryDescriptor *buffer = nullptr;
    ret = IOBufferMemoryDescriptor::Create(kIOMemoryDirectionOut, cbwLength, 0, &buffer);
    if (ret != kIOReturnSuccess || buffer == nullptr) {
        CELLARY_ERROR("buffer Create failed: 0x%x", ret);
        outPipe->release();
        iface->Close(this, 0);
        iface->release();
        return ret;
    }

    uint64_t address = 0;
    uint64_t length = 0;
    ret = buffer->Map(0, 0, 0, 0, &address, &length);
    if (ret == kIOReturnSuccess && address != 0) {
        memcpy((void *)address, cbw, cbwLength);
    }

    uint32_t bytesTransferred = 0;
    ret = outPipe->IO(buffer, cbwLength, &bytesTransferred, TRANSFER_TIMEOUT_MS);
    CELLARY_LOG("CBW sent: %u bytes, ret=0x%x", bytesTransferred, ret);

    if (isExpectedDisconnect(ret)) ret = kIOReturnSuccess;

    buffer->release();
    outPipe->release();
    iface->Close(this, 0);
    iface->release();

    return ret;
}

// -- Vendor control mode switch -----------------------------------------------

kern_return_t CellaryModeSwitcher::executeVendorControl(OSDictionary *properties) {
    // Read control transfer parameters from properties
    OSNumber *reqTypeNum = OSDynamicCast(OSNumber, properties->getObject("ControlRequestType"));
    OSNumber *reqNum = OSDynamicCast(OSNumber, properties->getObject("ControlRequest"));

    if (reqTypeNum == nullptr || reqNum == nullptr) {
        CELLARY_ERROR("vendor-control: missing ControlRequestType or ControlRequest");
        return kIOReturnBadArgument;
    }

    uint8_t bmRequestType = (uint8_t)reqTypeNum->unsigned32BitValue();
    uint8_t bRequest = (uint8_t)reqNum->unsigned32BitValue();

    uint16_t wValue = 0;
    uint16_t wIndex = 0;
    OSNumber *valNum = OSDynamicCast(OSNumber, properties->getObject("ControlValue"));
    OSNumber *idxNum = OSDynamicCast(OSNumber, properties->getObject("ControlIndex"));
    if (valNum != nullptr) wValue = (uint16_t)valNum->unsigned32BitValue();
    if (idxNum != nullptr) wIndex = (uint16_t)idxNum->unsigned32BitValue();

    CELLARY_LOG("vendor-control: type=0x%02x req=0x%02x val=0x%04x idx=0x%04x",
               bmRequestType, bRequest, wValue, wIndex);

    uint32_t bytesTransferred = 0;
    kern_return_t ret = ivars->device->DeviceRequest(
        this, bmRequestType, bRequest, wValue, wIndex,
        0, nullptr, &bytesTransferred, TRANSFER_TIMEOUT_MS
    );

    CELLARY_LOG("vendor-control sent, ret=0x%x", ret);
    return isExpectedDisconnect(ret) ? kIOReturnSuccess : ret;
}
