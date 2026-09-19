import { MODULE_CLIENT_TOKEN } from "./azure-storage-blob.constants";
import { AzureStorageBlobService } from "./azure-storage-blob.service";

export const getStorageBlobClientToken = (alias?: string): string =>
  alias ? `${MODULE_CLIENT_TOKEN}_${alias}` : MODULE_CLIENT_TOKEN;

export const getAzureStorageBlobServiceToken = (alias?: string) =>
  alias ? `STORAGE_BLOB_SERVICE_${alias}` : AzureStorageBlobService;
