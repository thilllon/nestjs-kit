import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./drizzle-pg.module-definition";

@Module({})
export class DrizzlePgModule extends ConfigurableModuleClass {}
