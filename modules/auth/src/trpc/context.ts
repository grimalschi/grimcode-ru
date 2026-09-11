/** Request data shared by the module's HTTP procedure contexts. */
export interface RpcContext {
  request: Request;
  resHeaders: Headers;
}
