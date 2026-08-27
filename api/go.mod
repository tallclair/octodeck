module github.com/tallclair/octodeck/api

go 1.26.5

tool (
	connectrpc.com/connect/cmd/protoc-gen-connect-go
	golang.org/x/tools/cmd/goimports
	google.golang.org/protobuf/cmd/protoc-gen-go
)

require (
	connectrpc.com/connect v1.20.0 // indirect
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/telemetry v0.0.0-20260708182218-49f421fb7959 // indirect
	golang.org/x/tools v0.48.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)
