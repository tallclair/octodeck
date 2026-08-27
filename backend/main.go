package main

import "github.com/tallclair/octodeck/backend/cmd"

func main() {
	cmd.SetFrontendFS(FrontendFS)
	cmd.Execute()
}
