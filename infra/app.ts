import { App } from "aws-cdk-lib";
import { SynodeStack } from "./synode-stack.js";

const app = new App();
new SynodeStack(app, "SynodeReference", {
  description: "Governed AI workflow control-plane reference architecture",
});
app.synth();
