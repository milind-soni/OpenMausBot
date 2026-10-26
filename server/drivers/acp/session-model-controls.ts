import type { ModelVariantOption } from "../../contracts.ts";
import { acpModelOption, acpVariantOption } from "./config-options.ts";

export interface AcpModelSelection {
  configId: string;
  /** A saved passthrough id that leaves the native session's model unchanged. */
  agentDefault?: string;
  /** Accept ACP's legacy models state and session/set_model when no model config option exists. */
  allowLegacy?: boolean;
}

interface ModelControlsInput {
  selection?: AcpModelSelection;
  variants: boolean;
  displayName: string;
  model(): string | undefined;
  reportedModel(): string | undefined;
  state(): any;
  store(result: any): void;
  report(model: string, variants: { options: ModelVariantOption[]; currentValue?: string }): void;
}

type Request = (method: string, params: unknown, timeoutMs: number, receive?: (result: any) => void) => Promise<any>;

export class SessionModelControls {
  private revision = 0;
  private readonly input: ModelControlsInput;
  constructor(input: ModelControlsInput) { this.input = input; }

  usesAgentDefault(): boolean {
    return this.input.selection?.agentDefault !== undefined
      && this.input.model() === this.input.selection.agentDefault;
  }

  modelOf(result: any): string | null {
    const configId = this.input.selection?.configId ?? "model";
    if (this.input.selection?.allowLegacy) return acpModelOption(result, configId)?.currentValue ?? null;
    const option = (Array.isArray(result?.configOptions) ? result.configOptions : [])
      .find((entry: any) => entry?.id === configId);
    return typeof option?.currentValue === "string" ? option.currentValue : null;
  }

  receive(result: any, replace = false): void {
    if (!replace && !Array.isArray(result?.configOptions) && !result?.models) return;
    const state = replace ? result : { ...this.input.state(), ...result };
    this.input.store(state);
    this.revision++;
    if (!this.input.variants) return;
    const model = this.input.model();
    const nativeModel = this.usesAgentDefault() ? model : this.modelOf(state) ?? model;
    if (!nativeModel) return;
    const option = acpVariantOption(state);
    this.input.report(nativeModel === model ? this.input.reportedModel() ?? nativeModel : nativeModel, {
      options: option?.options ?? [],
      ...(option?.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
    });
  }

  variant(value: string | undefined): NonNullable<ReturnType<typeof acpVariantOption>> {
    if (!this.input.variants) throw new Error(`${this.input.displayName} does not support model variants`);
    const option = acpVariantOption(this.input.state());
    if (!option || !option.options.some((entry) => entry.id === value)) {
      throw new Error(`${this.input.displayName} does not advertise variant ${value} for this model`);
    }
    return option;
  }

  async select(request: Request, sessionId: string, timeoutMs: number): Promise<string | null> {
    const wanted = this.input.model();
    let selected = this.modelOf(this.input.state());
    if (!wanted || this.usesAgentDefault() || wanted === selected) return selected;
    const configId = this.input.selection?.configId ?? "model";
    const option = this.input.selection?.allowLegacy ? acpModelOption(this.input.state(), configId) : undefined;
    if (option && option.configId === undefined) {
      if (!option.options.some((entry) => entry.id === wanted)) {
        throw new Error(`${this.input.displayName} does not advertise model ${wanted}`);
      }
      const before = this.revision;
      await request("session/set_model", { sessionId, modelId: wanted }, timeoutMs, (response) => {
        if (response?.models || Array.isArray(response?.configOptions)) this.receive(response, true);
        if (this.revision === before) {
          // ACP's legacy set_model succeeds with an empty result; it does not confirm the new model's thought options.
          this.receive({ models: { availableModels: option.options.map(({ id, label }) => ({ modelId: id, name: label })), currentModelId: wanted } }, true);
        }
      });
    } else {
      await request("session/set_config_option", { sessionId, configId: option?.configId ?? configId, value: wanted }, timeoutMs,
        (response) => this.receive(response));
    }
    selected = this.modelOf(this.input.state());
    if (selected !== wanted) {
      throw new Error(`${this.input.displayName} did not switch to ${wanted} (still ${selected ?? "unknown"})`);
    }
    return selected;
  }
}
