import { Injectable } from "@nestjs/common";
import {
  UploadApiErrorResponse,
  UploadApiOptions,
  UploadApiResponse,
  v2 as cloudinary,
} from "cloudinary";
import { Readable, pipeline } from "node:stream";
import type {
  IFile,
  ModuleOptions,
  SignedUploadUrlOptions,
} from "./cloudinary.interface";

export const defaultCreateSignedUploadUrlOptions: Partial<SignedUploadUrlOptions> =
  {
    folder: undefined,
    eager: undefined,
  };

@Injectable()
export class CloudinaryService {
  constructor(private readonly options: ModuleOptions) {}

  async onModuleInit(): Promise<void> {
    if (this.options.pingOnInit) await this.ping();
  }

  async ping() {
    return cloudinary.api.ping(this.getSdkOptions());
  }

  private getSdkOptions(apiSecret?: string, signing = false) {
    // The SDK has no account-scoped instance and falls back to arbitrary shared
    // settings, including OAuth and proxy configuration. Never inherit them.
    if (
      Object.keys(cloudinary.config()).length > 0 ||
      process.env.CLOUDINARY_URL ||
      process.env.CLOUDINARY_ACCOUNT_URL ||
      process.env.CLOUDINARY_API_PROXY
    ) {
      throw new Error(
        "CloudinaryService requires empty shared SDK configuration. Remove cloudinary.config() settings and CLOUDINARY_URL, CLOUDINARY_ACCOUNT_URL or CLOUDINARY_API_PROXY; pass configuration to each module registration instead.",
      );
    }
    const { pingOnInit: _pingOnInit, ...options } = this.options;
    const secret = apiSecret ?? options.api_secret;
    const present = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0;
    if (!present(options.cloud_name)) {
      throw new Error(
        "CloudinaryService requires a registration-local cloud_name.",
      );
    }
    if (signing || !present(options.oauth_token)) {
      if (!present(options.api_key) || !present(secret)) {
        throw new Error(
          "CloudinaryService requires registration-local api_key and api_secret (or an explicit oauth_token for ping/upload). Signed uploads always require api_key and api_secret.",
        );
      }
    }
    return {
      ...options,
      api_key: options.api_key,
      api_secret: secret,
      oauth_token: options.oauth_token,
      api_proxy: options.api_proxy,
      agent: options.agent,
      extra_headers: options.extra_headers,
      upload_prefix: options.upload_prefix ?? "https://api.cloudinary.com",
      signature_algorithm: options.signature_algorithm ?? "sha1",
      signature_version: options.signature_version ?? 2,
    };
  }

  /**
   * It returns a signed upload URL.
   * @see https://cloudinary.com/documentation/signatures#using_cloudinary_backend_sdks_to_generate_sha_authentication_signatures
   * @param {string} publicId - This is the public id of the file.(e.g. 'my_folder/my_file')
   * @param {SignedUploadUrlOptions} [options]
   * @returns string
   */
  async createSignedUploadUrl(
    options: SignedUploadUrlOptions,
    apiSecret?: string,
  ) {
    const sdkOptions = this.getSdkOptions(apiSecret, true);
    options = { ...defaultCreateSignedUploadUrlOptions, ...options };
    const url = cloudinary.utils.api_url("upload", {
      ...sdkOptions,
      resource_type: options.resource_type,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const { signature } = cloudinary.utils.sign_request(
      {
        public_id: options.public_id,
        timestamp,
        folder: options.folder,
        eager: options.eager,
      },
      sdkOptions,
    );

    return {
      url,
      timestamp,
      signature,
      api_key: this.options.api_key,
      ...options,
    };
  }

  /**
   * It takes a file, uploads it to cloudinary, and returns a promise
   * @param {IFile} file - IFile - This is the file object that is passed to the uploadFile method.
   * @param {UploadApiOptions} [options] - This is the options object that you can pass to the
   * uploader.upload_stream method.
   */
  async uploadFile(
    file: IFile,
    options?: UploadApiOptions,
  ): Promise<UploadApiResponse | UploadApiErrorResponse> {
    const sdkOptions = this.getSdkOptions();
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { ...options, ...sdkOptions },
        (error, result) => {
          if (error) return reject(error);
          if (!result)
            return reject(new Error("Cloudinary returned no upload result"));
          resolve(result);
        },
      );
      pipeline(Readable.from([file.buffer]), upload, (error) => {
        if (error) reject(error);
      });
    });
  }
}
