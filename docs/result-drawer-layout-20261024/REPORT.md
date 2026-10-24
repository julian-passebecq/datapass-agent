# Agent result drawer layout correction

The result drawer could cover the sticky navigation rail at medium webview widths. It now stays in the content column at 701-1100 pixels and returns to the single-column layout at <=700 pixels.

The regression renders the real workspace HTML/CSS offline. The old source fails at 1090, 900 and 701 pixels; the fixed source passes all six widths, including scroll and inspector hit testing. Targeted tests: 7/7; full suite: 552/552; typecheck and test compilation pass. Raw logs and the initial harness correction are preserved.

Problems: package, installed CI and ordinary VS Code validation of these new bytes remain separate pending gates. Headless layout tests are not native acceptance. No provider turn was sent. releasePass=false.

Questions: none for this bounded correction.
