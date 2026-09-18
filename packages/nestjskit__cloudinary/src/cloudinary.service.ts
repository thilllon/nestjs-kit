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

  ping() {
    return cloudinary.api.ping(this.sdkOptions);
  }

  private get sdkOptions() {
    const { pingOnInit: _pingOnInit, ...options } = this.options;
    return options;
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
    options = { ...defaultCreateSignedUploadUrlOptions, ...options };
    const url = cloudinary.utils.api_url("upload", {
      ...this.sdkOptions,
      upload_prefix: this.options.upload_prefix ?? "https://api.cloudinary.com",
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
      {
        ...this.sdkOptions,
        api_secret: apiSecret ?? this.options.api_secret,
        signature_algorithm: this.options.signature_algorithm ?? "sha1",
        signature_version: this.options.signature_version ?? 2,
      },
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
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { ...this.sdkOptions, ...options },
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
