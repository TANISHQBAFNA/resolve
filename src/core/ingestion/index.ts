export * from "./types";
export { parseFigmaFileKey, parseFigmaTarget, toFigmaNodeId, isFigmaLiveTarget } from "./figmaFileKey";
export {
  collectTopLevelScreens,
  fileFromNodesResponse,
  resolveIngestScope,
} from "./figmaScope";
export type { FigmaIngestScope, ScreenRef } from "./figmaScope";
export type { FigmaTarget } from "./figmaFileKey";
export { adaptFigmaRestFile, parseVariantName, UNKNOWN_LIBRARY_ID } from "./adapters/figmaRest";
export {
  FigmaRestIngestionSource,
  fetchFigmaRestDocument,
  figmaAccessToken,
  figmaApiOrigin,
} from "./adapters/figmaRestSource";
export { MockIngestionSource, mockIngestionSource, MOCK_FILE_KEY } from "./adapters/mockSource";
export { JsonIngestionSource } from "./adapters/jsonSource";
export {
  adaptFigmaMcpMetadata,
  parseMetadataXml,
  classifyTokenValue,
  figmaTypeForElement,
  inferredComponentId,
  isMetadataComponentSet,
  isVariantStyleName,
  realComponentIdFromAttrs,
  MCP_COLLECTION_ID,
} from "./adapters/figmaMcp";
export {
  applyLearnedIdentity,
  contextCarriesMasterIds,
  contextIdentityFor,
  elementComponentIds,
} from "./designContextIds";
