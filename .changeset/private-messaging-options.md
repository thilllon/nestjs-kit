---
"@nestjs-kit/cloudinary": major
"nestjs-pubnub": major
"@nestjs-kit/nodemailer": major
---

Access module-local configuration tokens through getCloudinaryOptionsToken, getPubNubOptionsToken and getNodemailerOptionsToken. Generated builder tokens stay private, and Cloudinary no longer exports MODULE_OPTIONS_TOKEN from its public entry point. Registration scoping, client aliases and lifecycle behavior remain unchanged.
