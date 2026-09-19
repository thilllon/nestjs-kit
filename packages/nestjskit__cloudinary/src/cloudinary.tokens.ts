import { CloudinaryService } from "./cloudinary.service";

export function getCloudinaryToken(alias = "default") {
  return !alias || alias === "default"
    ? CloudinaryService
    : `CLOUDINARY_${alias}`;
}
