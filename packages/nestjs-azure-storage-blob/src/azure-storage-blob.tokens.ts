import {
  MODULE_CLIENT_TOKEN,
  MODULE_OPTIONS_TOKEN,
} from "./azure-storage-blob.constants";
import { AzureStorageBlobService } from "./azure-storage-blob.service";

export const getStorageBlobClientToken = (alias?: string): string =>
  alias ? `${MODULE_CLIENT_TOKEN}:${alias}` : MODULE_CLIENT_TOKEN;

export const getStorageBlobOptionsToken = (alias?: string): string =>
  alias ? `${MODULE_OPTIONS_TOKEN}:${alias}` : MODULE_OPTIONS_TOKEN;

export const getAzureStorageBlobServiceToken = (alias?: string) =>
  alias ? `STORAGE_BLOB_SERVICE:${alias}` : AzureStorageBlobService;
