import { Inject } from "@nestjs/common";
import {
  getAzureStorageBlobServiceToken,
  getStorageBlobClientToken,
} from "./azure-storage-blob.tokens";

export function InjectStorageBlob(alias?: string): ReturnType<typeof Inject> {
  return Inject(getStorageBlobClientToken(alias));
}

export function InjectAzureStorageBlobService(
  alias?: string,
): ReturnType<typeof Inject> {
  return Inject(getAzureStorageBlobServiceToken(alias));
}
