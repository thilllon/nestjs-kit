export const MODULE_CLIENT_TOKEN = "STORAGE_BLOB_CLIENT";
const moduleOptionsToken = "STORAGE_BLOB_OPTIONS";

export function getAzureStorageBlobOptionsToken(alias?: string): string {
  return alias ? `${moduleOptionsToken}_${alias}` : moduleOptionsToken;
}
export const MODULE_CONNECTION_VARIABLE_TOKEN =
  "NESTJS_STORAGE_BLOB_CONNECTION";
