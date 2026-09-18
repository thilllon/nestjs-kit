import { Inject } from "@nestjs/common";
import { CloudinaryService } from "./cloudinary.service";

export function getCloudinaryToken(alias = "default") {
  return !alias || alias === "default"
    ? CloudinaryService
    : `CLOUDINARY_${alias}`;
}

export function InjectCloudinary(alias?: string): ParameterDecorator {
  return Inject(getCloudinaryToken(alias));
}
