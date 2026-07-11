import SwiftUI
import SystemExtensions

/// Container app for the CellaryModeSwitcher DriverKit extension.
///
/// This app's sole purpose is to install/activate/deactivate the DEXT.
/// Once activated, the DEXT runs independently as a system extension --
/// the app does not need to stay running.
@main
struct CellaryDriverApp: App {
    @StateObject private var manager = ExtensionManager()

    var body: some Scene {
        WindowGroup {
            ContentView(manager: manager)
        }
    }
}

// MARK: - Content View

struct ContentView: View {
    @ObservedObject var manager: ExtensionManager

    var body: some View {
        VStack(spacing: 20) {
            Text("cellary USB Mode Switch Driver")
                .font(.title2)
                .fontWeight(.semibold)

            Text(manager.statusMessage)
                .foregroundColor(manager.isError ? .red : .secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)

            HStack(spacing: 12) {
                Button("Activate") {
                    manager.activate()
                }
                .disabled(manager.isActivating)

                Button("Deactivate") {
                    manager.deactivate()
                }
                .disabled(manager.isActivating)
            }

            Text("After activation, approve the extension in\nSystem Settings > General > Login Items & Extensions")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(40)
        .frame(minWidth: 500, minHeight: 300)
    }
}

// MARK: - Extension Manager

final class ExtensionManager: NSObject, ObservableObject, OSSystemExtensionRequestDelegate {
    static let dextIdentifier = "com.cellary.driver.ModeSwitcher"

    @Published var statusMessage = "Driver not activated."
    @Published var isActivating = false
    @Published var isError = false

    func activate() {
        isActivating = true
        isError = false
        statusMessage = "Requesting activation..."

        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: Self.dextIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func deactivate() {
        isActivating = true
        isError = false
        statusMessage = "Requesting deactivation..."

        let request = OSSystemExtensionRequest.deactivationRequest(
            forExtensionWithIdentifier: Self.dextIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    // MARK: - OSSystemExtensionRequestDelegate

    func request(
        _ request: OSSystemExtensionRequest,
        didFinishWithResult result: OSSystemExtensionRequest.Result
    ) {
        isActivating = false
        switch result {
        case .completed:
            statusMessage = "Driver activated. USB modems will be auto-switched."
            isError = false
        case .willCompleteAfterReboot:
            statusMessage = "Driver will activate after reboot."
            isError = false
        @unknown default:
            statusMessage = "Unknown result: \(result)"
            isError = true
        }
    }

    func request(
        _ request: OSSystemExtensionRequest,
        didFailWithError error: Error
    ) {
        isActivating = false
        isError = true

        let nsError = error as NSError
        switch nsError.code {
        case 4:
            statusMessage = "Missing entitlements. See README for development setup."
        case 8:
            statusMessage = "Extension not found in app bundle. Rebuild in Xcode."
        case 9:
            statusMessage = "Extension disabled by user. Re-enable in System Settings."
        default:
            statusMessage = "Failed: \(error.localizedDescription)"
        }
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        statusMessage = "Approval required. Open System Settings > General > Login Items & Extensions."
    }

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        statusMessage = "Replacing existing driver..."
        return .replace
    }
}
