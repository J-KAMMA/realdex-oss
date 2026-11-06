# Independent reference used for the 72 Keccak vectors

`main.go` is the small reference driver used in this work. It accepts one hex input per line and prints `sha3.NewLegacyKeccak256` digests.

The recorded run used Go **1.23.2 linux/amd64**, with `golang.org/x/crypto/sha3` and `golang.org/x/sys/cpu` copied from that Go installation's `src/vendor/` into an isolated temporary GOPATH, then built with `GO111MODULE=off` and `-tags purego`. The third-party implementation itself is not bundled here. This is independent of the JavaScript Keccak implementation; it is not SHA3-256.

`../keccak-go-vectors.json` records 72 digests and reproducible input lengths/seeds. The byte recipe is `((i*29+seed*17)^(i>>3)^seed)&255`. The Node regression tests regenerate these inputs and compare the JavaScript outputs against the recorded reference outputs.

This is a vector check, not a cryptographic security audit or proof of correct execution for every input.
