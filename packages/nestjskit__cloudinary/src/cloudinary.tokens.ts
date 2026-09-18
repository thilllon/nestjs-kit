import { Inject } from "@nestjs/common";
import { CloudinaryService } from "./cloudinary.service";

export function getCloudinaryToken(alias = "default") {
  if (!alias.trim() || alias !== alias.trim()) {
    throw new Error(
      "Cloudinary alias must be a non-empty string without surrounding whitespace",
    );
  }
  return alias === "default" ? CloudinaryService : `CLOUDINARY_${alias}`;
}

export function InjectCloudinary(alias?: string): ParameterDecorator {
  return Inject(getCloudinaryToken(alias));
}
