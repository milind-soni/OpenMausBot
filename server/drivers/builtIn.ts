import type { AnyProviderDriver } from "../contracts.ts";
import { isFullEdition } from "../product-edition.ts";
import { FULL_BUILT_IN_DRIVERS } from "./fullBuiltIn.ts";
import { LOCAL_BUILT_IN_DRIVERS } from "./localBuiltIn.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = isFullEdition()
  ? FULL_BUILT_IN_DRIVERS
  : LOCAL_BUILT_IN_DRIVERS;
