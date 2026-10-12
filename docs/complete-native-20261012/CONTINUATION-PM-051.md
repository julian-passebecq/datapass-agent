# Installed composition continuation

The owner authorized the bounded FULL continuation in chat 01a131bc-6180-7bb1-afc1-fd83729776a5 on 12 October 2026. This change updates only Agent's installed composition fixture, its hosted qualification script/workflow, and integrity tests.

Current PM fixture: 0.5.1 at 25143d561ba4a962e880a35333a66837a2b0dc39, Windows package SHA256 a034665a161ea2a426415a1f1eb46c719ac9d2c3040d3f30273f47aaa4e77b56. Exact local Node 22.23.3 qualification passed 206 tests, typecheck, clean install and packaging. The prior PM 0.5.0 receipt and package remain retained.

Config dependency: 0.8.1 at 7d080980a0c679b6106a7e655450340dc8862edf, package SHA256 a7aab6434d54d1253820c214241174f5407dd1175001cd1566ba8f0b3a6ee7a0. Reuse the verified carrier 2939906408 job 17121915776 artifact. Its prior 0.7.2 fixture and receipt remain historical.

Agent runtime 0.11.1 and sealed provider-kit 1.1.1 are unchanged. The fixture packages are excluded from the Agent VSIX. This fixture update does not certify installation, authentication, the owner desktop or actual provider execution. Hosted installed smoke remains a separate explicit gate; its host guard is unchanged and was not bypassed.

Exact consumer source e80341589bccbed23fef40b024c30c8f83819ba7 passed all original mandatory Windows gates and 486/486 tests in carrier pipeline 2940115143, job 17123456099, carrier source f9911c5600804edd602080a3e444549dfc7bb5cd. Downloaded receipt, recipe, concrete gate, log and artifact bytes were hash-verified. See continuation-carrier-verification.json. The Agent VSIX is 488400 bytes, SHA256 94d80dd20324c82c6668bdb0343c3dc7136e348354587513994471517d1146ca; its artifact expiry is 2026-11-11T20:56:30.974Z.

The extension/dist/extension.js bytes in the prior qualified fa2ca93 carrier package and this e803415 package are identical: 1314831 bytes, SHA256 31ca8f9776a5f6b98de3067d059a2a7f54aaaba0cd2abb406ad9efdefb9ba333. Package archive hashes differ and are recorded independently. Agent src and provider-kit have no changes from the prior candidate. Immutable provider-kit 1.1.1 remains at its previously qualified producer.

GitHub run 38306645053 failed before any steps because of account billing; continuation-hosted-checks.json retains the exact-source annotation. The carrier does not substitute for that required check. Later documentation commits are publication wrappers, distinct from tested e803415 source. Resume from these receipts and pins; do not repeat unchanged Config/Lens runtime suites. No merge, deployment, global permission or live provider operation is authorized by this fixture update.
