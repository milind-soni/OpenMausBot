import { setGlobalProxyFromEnv } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

if (process.env.OMB_DESKTOP_PROXY) {
  setGlobalProxyFromEnv();
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
