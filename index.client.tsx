// The authored client entry lives in client/plugin-entry.tsx. This tiny,
// stable entry lets Paseo compile the generated minified bundle without
// changing its standard index.client.tsx contract.
export { default } from "./client/generated-entry.js";
