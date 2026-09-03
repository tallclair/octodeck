package cmd

import (
	"bytes"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tallclair/octodeck/backend/internal/server"
)

func TestRootCmd_Version(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{
			name: "long flag --version",
			args: []string{"--version"},
		},
		{
			name: "short flag -v",
			args: []string{"-v"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			buf := new(bytes.Buffer)
			rootCmd.SetOut(buf)
			rootCmd.SetErr(buf)
			rootCmd.SetArgs(tt.args)

			t.Cleanup(func() {
				rootCmd.SetOut(nil)
				rootCmd.SetErr(nil)
				rootCmd.SetArgs(nil)
				if f := rootCmd.Flags().Lookup("version"); f != nil {
					_ = f.Value.Set("false")
				}
			})

			err := rootCmd.Execute()
			require.NoError(t, err)

			expected := fmt.Sprintf("octodeck version %s\n", server.Version)
			assert.Equal(t, expected, buf.String())
		})
	}
}

func TestRootCmd_HelpListsVersionFlag(t *testing.T) {
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetArgs([]string{"--help"})

	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
		if f := rootCmd.Flags().Lookup("help"); f != nil {
			_ = f.Value.Set("false")
		}
	})

	err := rootCmd.Execute()
	require.NoError(t, err)
	assert.Contains(t, buf.String(), "OctoDeck is a locally hosted dashboard")
	assert.Contains(t, buf.String(), "-v, --version")
}
