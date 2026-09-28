/** True when this Node cannot run Resolve. 22.12+ is required; 24+ is fine. */
export function nodeVersionTooOld(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 22 || (major === 22 && minor < 12);
}

export function nodeVersionMessage(version) {
  const shown = version.startsWith("v") ? version : `v${version}`;
  return `Resolve needs Node.js 22.12 or newer (this is ${shown}). Install the LTS from https://nodejs.org\n`;
}
