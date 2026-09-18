import { Inject, Injectable } from "@nestjs/common";
import {
  UploadApiErrorResponse,
  UploadApiOptions,
  UploadApiResponse,
  v2 as cloudinary,
} from "cloudinary";
import { Readable, pipeline } from "node:stream";
import sharp from "sharp";
import type {
  IFile,
  ModuleOptions,
  SharpInputOptions,
  SignedUploadUrlOptions,
} from "./cloudinary.interface";
import { MODULE_OPTIONS_TOKEN } from "./cloudinary.module-definition";

export const defaultCreateSignedUploadUrlOptions: Partial<SignedUploadUrlOptions> =
  {
    folder: undefined,
    eager: undefined,
  };

@Injectable()
export class CloudinaryService {
  public readonly cloudinary = cloudinary;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: ModuleOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.options.pingOnInit) await this.ping();
  }

  ping() {
    return this.cloudinary.api.ping(this.sdkOptions);
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
    const url = `https://api.cloudinary.com/v1_1/${this.options.cloud_name}/${options.resource_type}/upload`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.cloudinary.utils.api_sign_request(
      {
        public_id: options.public_id,
        timestamp,
        folder: options.folder,
        eager: options.eager,
      },
      apiSecret ?? this.options.api_secret ?? "",
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
   * @param {SharpInputOptions} [sharpOptions] - This is an object that contains the options for sharp.
   */
  async uploadFile(
    file: IFile,
    options?: UploadApiOptions,
    sharpOptions?: SharpInputOptions,
  ): Promise<UploadApiResponse | UploadApiErrorResponse> {
    const buffer =
      sharpOptions && file.mimetype.startsWith("image/")
        ? await sharp(file.buffer, sharpOptions.options)
            .resize({ width: sharpOptions.width, height: sharpOptions.height })
            .toBuffer()
        : file.buffer;
    return new Promise((resolve, reject) => {
      const upload = this.cloudinary.uploader.upload_stream(
        { ...this.sdkOptions, ...options },
        (error, result) => {
          if (error) return reject(error);
          if (!result)
            return reject(new Error("Cloudinary returned no upload result"));
          resolve(result);
        },
      );
      pipeline(Readable.from([buffer]), upload, (error) => {
        if (error) reject(error);
      });
    });
  }

  get instance() {
    return this.cloudinary;
  }
}
