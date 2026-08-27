package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	octodeckv1 "github.com/tallclair/octodeck/backend/internal/api/octodeck/v1"
)

var botSuffixRegex = regexp.MustCompile(`(?i)\[(?:bot|robot)\]$`)

// NormalizeKnownBots strips [bot] or [robot] suffixes, trims whitespace,
// lowercases, deduplicates, and sorts alphabetically.
func NormalizeKnownBots(bots []string) []string {
	seen := make(map[string]struct{}, len(bots))
	var result []string
	for _, b := range bots {
		trimmed := strings.TrimSpace(b)
		if trimmed == "" {
			continue
		}
		clean := strings.ToLower(botSuffixRegex.ReplaceAllString(trimmed, ""))
		clean = strings.TrimSpace(clean)
		if clean == "" {
			continue
		}
		if _, ok := seen[clean]; !ok {
			seen[clean] = struct{}{}
			result = append(result, clean)
		}
	}
	slices.Sort(result)
	return result
}

const (
	// DefaultSyncInterval is the default interval for syncing with GitHub.
	DefaultSyncInterval = 1 * time.Minute
	// DefaultGCInterval is the default interval for garbage collection.
	DefaultGCInterval = 24 * time.Hour
	// MinSyncInterval is the minimum allowed synchronization interval.
	MinSyncInterval = 5 * time.Second

	// DefaultStaleItemAge is the age at which an item is considered stale.
	DefaultStaleItemAge = 30 * 24 * time.Hour // 30 days
	// DefaultPruneItemAge is the age at which an item is pruned from the database.
	DefaultPruneItemAge = 90 * 24 * time.Hour // 90 days

	// DefaultPort is the default port for the server.
	DefaultPort = 38274

	// DefaultDevServer is the default Vite dev server URL.
	DefaultDevServer = "http://localhost:5173"

	// DevExtensionID is the Chrome Extension ID for development.
	DevExtensionID = "aehnmdipkljkahkgjchbiobichdaigjd"

	// AuthCodeExpiry is the expiration time for authorization codes.
	AuthCodeExpiry = 10 * time.Minute
	// SyncHeartbeatTimeout is the timeout for the heartbeat sync.
	SyncHeartbeatTimeout = 10 * time.Minute
	// SyncGCTimeout is the timeout for garbage collection.
	SyncGCTimeout = 30 * time.Minute
	// ServerRequestTimeout is the timeout for server requests.
	ServerRequestTimeout = 5 * time.Minute
	// ServerReadHeaderTimeout is the timeout for reading request headers.
	ServerReadHeaderTimeout = 5 * time.Second
	// ServerShutdownTimeout is the timeout for graceful server shutdown.
	ServerShutdownTimeout = 5 * time.Second
)

// DefaultKnownBots returns the default sorted list of known bot usernames in lowercase without [bot] suffixes.
func DefaultKnownBots() []string {
	return []string{
		"codecov",
		"codecov-commenter",
		"dependabot",
		"fejta-bot",
		"github-actions",
		"google-cla",
		"googlebot",
		"k8s-bot",
		"k8s-ci-robot",
		"k8s-merge-robot",
		"k8s-prow-robot",
		"k8s-reviewable",
		"k8s-triage-robot",
		"kubernetes-prow",
		"mergify",
		"prow",
		"renovate",
		"stale",
	}
}

// Overrides contains configuration overrides (e.g., from CLI flags).
type Overrides struct {
	Port      int
	DBPath    string
	DevServer string
}

// Config holds the runtime configuration.
type Config struct {
	data      atomic.Pointer[octodeckv1.Config]
	overrides Overrides
	path      string
	mu        sync.Mutex // For serializing writes to the file
}

// NewForTest creates a new Config instance for testing purposes.
func NewForTest(data *octodeckv1.Config) *Config {
	cfg := &Config{
		path: "/dev/null", // Default dummy path for tests
	}
	val, _ := proto.Clone(data).(*octodeckv1.Config)
	if len(val.GetKnownBots()) > 0 {
		val.SetKnownBots(NormalizeKnownBots(val.GetKnownBots()))
	}
	cfg.data.Store(val)
	return cfg
}

// GetPath returns the path to the configuration file.
func (c *Config) GetPath() string {
	return c.path
}

// GetExtensionID returns the ID of the Chrome extension.
func (c *Config) GetExtensionID() string {
	// In the future, this could be configurable via the config file
	return DevExtensionID
}

// GetKnownBots returns the list of known bot usernames.
func (c *Config) GetKnownBots() []string {
	return c.data.Load().GetKnownBots()
}

// AddKnownBots normalizes and adds bot usernames to the configuration.
// If new bots were added, it persists the updated configuration to disk.
// Returns the updated list of known bots, whether any were added, and any save error.
func (c *Config) AddKnownBots(logins ...string) ([]string, bool, error) {
	if len(logins) == 0 {
		return c.GetKnownBots(), false, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	current := c.data.Load()
	currentBots := current.GetKnownBots()
	merged := append(slices.Clone(currentBots), logins...)
	normalized := NormalizeKnownBots(merged)

	if slices.Equal(currentBots, normalized) {
		return currentBots, false, nil
	}

	updated, _ := proto.Clone(current).(*octodeckv1.Config)
	updated.SetKnownBots(normalized)
	c.data.Store(updated)

	err := c.saveLocked()
	return normalized, true, err
}

// GetWatchedRepos returns the list of repositories being watched.
func (c *Config) GetWatchedRepos() []string {
	return c.data.Load().GetWatchedRepos()
}

// GetPinnedRepos returns the list of repositories pinned in the sidebar.
func (c *Config) GetPinnedRepos() []string {
	return c.data.Load().GetPinnedRepos()
}

// GetExcludedRepos returns the list of repositories excluded from monitoring.
func (c *Config) GetExcludedRepos() []string {
	return c.data.Load().GetExcludedRepos()
}

// GetPollingIntervalMin returns the polling interval in minutes.
func (c *Config) GetPollingIntervalMin() int32 {
	return c.data.Load().GetPollingIntervalMin()
}

// GetSyncInterval returns the synchronization interval as a [time.Duration].
func (c *Config) GetSyncInterval() time.Duration {
	d := c.data.Load()
	if d == nil || d.GetPollingIntervalMin() <= 0 {
		return DefaultSyncInterval
	}
	interval := time.Duration(d.GetPollingIntervalMin()) * time.Minute
	if interval < MinSyncInterval {
		return DefaultSyncInterval
	}
	return interval
}

// GetAutoAckOwnActivity returns whether to automatically acknowledge own activity.
func (c *Config) GetAutoAckOwnActivity() bool {
	return c.data.Load().GetAutoAckOwnActivity()
}

// GetDevServer returns the dev server URL for reverse proxying if configured.
func (c *Config) GetDevServer() string {
	if c.overrides.DevServer == "true" || c.overrides.DevServer == "default" {
		return DefaultDevServer
	}
	return c.overrides.DevServer
}

// GetPort returns the server port.
func (c *Config) GetPort() int {
	if c.overrides.Port != 0 {
		return c.overrides.Port
	}
	// Fallback to config file or default
	val := int(c.data.Load().GetPort())
	if val == 0 {
		return DefaultPort
	}
	return val
}

// GetDBPath returns the path to the database file.
func (c *Config) GetDBPath() (string, error) {
	if c.overrides.DBPath != "" {
		return c.overrides.DBPath, nil
	}
	val := c.data.Load().GetDbPath()
	if val == "" {
		// Calculate default if not set
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("failed to get user home directory: %w", err)
		}
		return filepath.Join(home, ".octodeck", "octodeck.db"), nil
	}
	return val, nil
}

// GetProto returns the underlying protocol buffer configuration.
func (c *Config) GetProto() *octodeckv1.Config {
	// Return the config as represented in the file/storage
	// Note: This does NOT include overrides, allowing the frontend to see the persistent state
	val, _ := proto.Clone(c.data.Load()).(*octodeckv1.Config)
	return val
}

// UpdateProto updates the configuration with new values.
func (c *Config) UpdateProto(newCfg *octodeckv1.Config, mask *fieldmaskpb.FieldMask) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if mask == nil || len(mask.GetPaths()) == 0 {
		val, _ := proto.Clone(newCfg).(*octodeckv1.Config)
		if len(val.GetKnownBots()) > 0 {
			val.SetKnownBots(NormalizeKnownBots(val.GetKnownBots()))
		}
		c.data.Store(val)
	} else {
		current, _ := proto.Clone(c.data.Load()).(*octodeckv1.Config)
		applyFieldMask(current, newCfg, mask)
		if len(current.GetKnownBots()) > 0 {
			current.SetKnownBots(NormalizeKnownBots(current.GetKnownBots()))
		}
		c.data.Store(current)
	}
	return c.saveLocked()
}

func applyFieldMask(dst, src protoreflect.ProtoMessage, mask *fieldmaskpb.FieldMask) {
	dstReflect := dst.ProtoReflect()
	srcReflect := src.ProtoReflect()
	fields := dstReflect.Descriptor().Fields()

	for _, path := range mask.GetPaths() {
		// This implementation only supports top-level fields, which is sufficient for Config
		fd := fields.ByJSONName(path)
		if fd == nil {
			fd = fields.ByName(protoreflect.Name(path))
		}
		if fd != nil {
			dstReflect.Set(fd, srcReflect.Get(fd))
		}
	}
}

// GetConfigPath returns the default path for the configuration file.
func GetConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".octodeck", "config.json"), nil
}

// Load reads the configuration from the specified path or the default location.
func Load(customPath string, overrides Overrides) (*Config, error) {
	cfg := &Config{
		overrides: overrides,
	}

	path := customPath
	var err error
	if path == "" {
		path, err = GetConfigPath()
		if err != nil {
			return nil, err
		}
	}
	cfg.path = path

	// Default config
	data := octodeckv1.Config_builder{
		PollingIntervalMin: Ptr(int32(DefaultSyncInterval.Minutes())),
		KnownBots:          DefaultKnownBots(),
		AutoAckOwnActivity: Ptr(true),
		Port:               Ptr(int32(DefaultPort)),
	}.Build()
	cfg.data.Store(data)

	fileData, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		// Return default if not exists
		return cfg, nil
	} else if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	// Use protojson to unmarshal
	// DiscardUnknown: true helps with forward compatibility
	unmarshaller := protojson.UnmarshalOptions{DiscardUnknown: true}
	// We need to unmarshal into a new object and then store it to keep it atomic
	newData, _ := proto.Clone(data).(*octodeckv1.Config)
	if err := unmarshaller.Unmarshal(fileData, newData); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}
	if len(newData.GetKnownBots()) > 0 {
		newData.SetKnownBots(NormalizeKnownBots(newData.GetKnownBots()))
	}
	cfg.data.Store(newData)

	return cfg, nil
}

// Save persists the current configuration to disk.
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.saveLocked()
}

func (c *Config) saveLocked() error {
	if c.path == "" {
		return errors.New("config path not set")
	}

	if err := os.MkdirAll(filepath.Dir(c.path), 0750); err != nil {
		return err
	}

	marshaller := protojson.MarshalOptions{Multiline: true, Indent: "  "}
	data, err := marshaller.Marshal(c.data.Load())
	if err != nil {
		return err
	}

	return os.WriteFile(c.path, data, 0600)
}
