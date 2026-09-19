# @nestjs-kit/nodemailer

## 2.0.0

### Major Changes

- 77a3f7c: Use Nest Inject with the public account-token helpers or NODEMAILER_TRANSPORTER instead of package-specific injection decorators. Nodemailer message delivery and verification now use the exposed transporter directly; lifecycle management remains in the service. Cloudinary account isolation, signing and upload behavior are unchanged.

## 1.0.0

### Major Changes

- af7c7b4: Introduce Nodemailer integration with synchronous and asynchronous NestJS configuration, injectable transporters, message defaults, and managed shutdown.
