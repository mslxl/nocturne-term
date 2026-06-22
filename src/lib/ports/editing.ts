import type {
  PortForwardDirection,
  PortForwardDraft,
  PortForwardNonLoopbackConfirmation,
  PortForwardPersistence,
  PortForwardRule_Deserialize,
  PortForwardRuleInput_Deserialize,
  PortForwardRuleSnapshot_Deserialize,
} from "$lib/bindings";

export type PortForwardEditModel = {
  id: string;
  name: string;
  direction: PortForwardDirection;
  localAddress: string;
  localPort: string;
  remoteAddress: string;
  remotePort: string;
  persistence: PortForwardPersistence;
  connectOnHostOpen: boolean;
};

export type PortForwardEditValidation = {
  fieldErrors: Partial<Record<keyof PortForwardEditModel, string>>;
};

export function editModelFromSnapshot(row: PortForwardRuleSnapshot_Deserialize): PortForwardEditModel {
  return {
    id: row.rule.id,
    name: row.rule.name,
    direction: row.rule.direction,
    localAddress: row.rule.local_address,
    localPort: String(row.rule.local_port),
    remoteAddress: row.rule.remote_address,
    remotePort: String(row.rule.remote_port),
    persistence: row.runtime.persistence,
    connectOnHostOpen: row.rule.connect_on_host_open ?? true,
  };
}

export function editModelFromDraft(draft: PortForwardDraft | null): PortForwardEditModel {
  return {
    id: "",
    name: draft?.name ?? "",
    direction: draft?.direction ?? "local_to_remote",
    localAddress: draft?.local_address ?? "127.0.0.1",
    localPort: draft?.local_port ?? "0",
    remoteAddress: draft?.remote_address ?? "127.0.0.1",
    remotePort: draft?.remote_port ?? "0",
    persistence: draft?.persistence ?? "just_this_time",
    connectOnHostOpen: draft?.connect_on_host_open ?? true,
  };
}

export function draftFromEditModel(model: PortForwardEditModel): PortForwardDraft {
  return {
    name: model.name,
    direction: model.direction,
    local_address: model.localAddress,
    local_port: model.localPort,
    remote_address: model.remoteAddress,
    remote_port: model.remotePort,
    persistence: model.persistence,
    connect_on_host_open: model.connectOnHostOpen,
  };
}

export function editModelsEqual(left: PortForwardEditModel, right: PortForwardEditModel): boolean {
  return left.name === right.name
    && left.direction === right.direction
    && left.localAddress === right.localAddress
    && left.localPort === right.localPort
    && left.remoteAddress === right.remoteAddress
    && left.remotePort === right.remotePort
    && left.persistence === right.persistence
    && left.connectOnHostOpen === right.connectOnHostOpen;
}

export function buildRuleInput(
  hostId: string,
  model: PortForwardEditModel,
  existingRule: PortForwardRule_Deserialize | null,
): PortForwardRuleInput_Deserialize {
  const validation = validateEditModel(model);
  if (Object.keys(validation.fieldErrors).length > 0) {
    throw new PortForwardEditError(validation);
  }
  return {
    host_id: hostId,
    persistence: model.persistence,
    rule: {
      id: model.id || crypto.randomUUID(),
      name: model.name.trim(),
      direction: model.direction,
      local_address: model.localAddress.trim(),
      local_port: parsePort(model.localPort),
      remote_address: model.remoteAddress.trim(),
      remote_port: parsePort(model.remotePort),
      connect_on_host_open: model.connectOnHostOpen,
      non_loopback_confirmations: existingRule?.non_loopback_confirmations ?? [],
    },
  };
}

export function addNonLoopbackConfirmation(
  rule: PortForwardRule_Deserialize,
  confirmedAtUnixMs: string,
): PortForwardRule_Deserialize {
  const confirmation: PortForwardNonLoopbackConfirmation = {
    semantic_key: {
      direction: rule.direction,
      local_address: rule.local_address,
      local_port: rule.local_port,
      remote_address: rule.remote_address,
      remote_port: rule.remote_port,
    },
    confirmed_at_unix_ms: confirmedAtUnixMs,
  };
  const existing = rule.non_loopback_confirmations ?? [];
  return {
    ...rule,
    non_loopback_confirmations: [
      ...existing.filter((item) => !confirmationMatches(item, confirmation)),
      confirmation,
    ],
  };
}

export function validateEditModel(model: PortForwardEditModel): PortForwardEditValidation {
  const fieldErrors: PortForwardEditValidation["fieldErrors"] = {};
  if (!model.localAddress.trim()) fieldErrors.localAddress = "Local address is required";
  if (!model.remoteAddress.trim()) fieldErrors.remoteAddress = "Remote address is required";
  const localPort = parseOptionalPort(model.localPort);
  const remotePort = parseOptionalPort(model.remotePort);
  if (localPort == null) fieldErrors.localPort = "Use 0-65535";
  if (remotePort == null) fieldErrors.remotePort = "Use 0-65535";
  return { fieldErrors };
}

export function canDeleteWithoutConfirmation(row: PortForwardRuleSnapshot_Deserialize): boolean {
  return row.runtime.active_connections === 0
    && row.runtime.status !== "running"
    && row.runtime.status !== "starting"
    && row.runtime.status !== "reconnecting";
}

export class PortForwardEditError extends Error {
  constructor(readonly validation: PortForwardEditValidation) {
    super("Port forward edit is invalid");
  }
}

function parsePort(value: string): number {
  const port = parseOptionalPort(value);
  if (port == null) throw new Error(`invalid port: ${value}`);
  return port;
}

function parseOptionalPort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed;
}

function confirmationMatches(
  left: PortForwardNonLoopbackConfirmation,
  right: PortForwardNonLoopbackConfirmation,
): boolean {
  return left.semantic_key.direction === right.semantic_key.direction
    && left.semantic_key.local_address === right.semantic_key.local_address
    && left.semantic_key.local_port === right.semantic_key.local_port
    && left.semantic_key.remote_address === right.semantic_key.remote_address
    && left.semantic_key.remote_port === right.semantic_key.remote_port;
}
