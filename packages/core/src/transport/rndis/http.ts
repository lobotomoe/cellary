/**
 * Re-export from the shared HTTP client.
 * The implementation moved to transport/http.ts to support both RNDIS and ECM.
 */
export { type HttpResponse, httpGet, httpPost } from '../http.js'
