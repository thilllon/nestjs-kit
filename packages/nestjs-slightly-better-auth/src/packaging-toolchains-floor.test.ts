import {
  describeDeclarationConsumers,
  installToolchainConsumers,
} from "./packaging-toolchains-fixture.js";

// The declaration consumers at the floor peer versions. The current row and
// the bundlers are in packaging-toolchains-current.test.ts.

installToolchainConsumers(["floor"]);

describeDeclarationConsumers("floor");
