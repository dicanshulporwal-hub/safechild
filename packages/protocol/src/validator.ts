import { CURRENT_PROTOCOL_VERSION, ProtocolVersion } from './contracts';

export function isProtocolVersionCompatible(version?: string): boolean {
  if (!version) return true; // Default fallback for v1.0
  const [major] = version.split('.');
  const [currentMajor] = CURRENT_PROTOCOL_VERSION.split('.');
  return major === currentMajor;
}

export function validateProtocolVersion(version?: string): ProtocolVersion {
  if (version && !isProtocolVersionCompatible(version)) {
    throw new Error(`Incompatible protocol version '${version}'. Server supports version ${CURRENT_PROTOCOL_VERSION}.`);
  }
  return CURRENT_PROTOCOL_VERSION;
}
