import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./cloudinary.module-definition";

@Module({})
export class CloudinaryModule extends ConfigurableModuleClass {}
