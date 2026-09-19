---
"@nestjs-kit/cloudinary": major
"nestjs-pubnub": major
"@nestjs-kit/nodemailer": major
---

Use Nest Inject with the public account-token helpers or NODEMAILER_TRANSPORTER instead of package-specific injection decorators. Nodemailer message delivery and verification now use the exposed transporter directly; lifecycle management remains in the service. Cloudinary account isolation, signing and upload behavior are unchanged.
