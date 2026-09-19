# @nestjs-kit/nodemailer

## 3.0.0

### Major Changes

- 03465d6: Access module-local configuration tokens through getCloudinaryOptionsToken, getPubNubOptionsToken and getNodemailerOptionsToken. Generated builder tokens stay private, and Cloudinary no longer exports MODULE_OPTIONS_TOKEN from its public entry point. Registration scoping, client aliases and lifecycle behavior remain unchanged.

## 2.0.0

### Major Changes

- 77a3f7c: Use Nest Inject with the public account-token helpers or NODEMAILER_TRANSPORTER instead of package-specific injection decorators. Nodemailer message delivery and verification now use the exposed transporter directly; lifecycle management remains in the service. Cloudinary account isolation, signing and upload behavior are unchanged.

## 1.0.0

### Major Changes

- af7c7b4: Introduce Nodemailer integration with synchronous and asynchronous NestJS configuration, injectable transporters, message defaults, and managed shutdown.
