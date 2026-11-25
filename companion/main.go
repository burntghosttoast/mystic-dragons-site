// Mystic Dragons companion app.
//
// Runs on one officer's Windows PC while they play. Every couple of minutes it:
//   1. gets the latest approved DKP sheet from the site and drops it into a small helper addon
//      (MysticDragonsBids_Inbox) so the bidding addon loads it at the next login or /reload,
//      and shares it with everyone online;
//   2. looks at the bidding addon's saved results (written by the game at logout or /reload)
//      and sends any new ones to the site as draft loot awards. The site skips ones it already has.
//
// Settings live in %APPDATA%\MysticDragonsCompanion\config.json.
// Build: GOOS=windows GOARCH=amd64 go build -o MysticDragonsCompanion.exe
package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const version = "0.1.0"

type Config struct {
	Site     string            `json:"site"`
	WowPath  string            `json:"wowPath"` // the _forever_ folder
	Name     string            `json:"name"`
	Token    string            `json:"token"`
	Sheet    string            `json:"lastSheet"`     // last sheet written to the inbox
	Uploaded map[string]string `json:"lastUploaded"`  // per saved-variables file: hash of the last export sent
	Warned   map[string]string `json:"lastWarned"`    // per file: hash of the last export whose problems were shown
}

var (
	cfg     Config
	cfgPath string
	in      = bufio.NewReader(os.Stdin)
	client  = &http.Client{Timeout: 30 * time.Second}
)

func say(format string, a ...any) {
	fmt.Printf("%s  %s\n", time.Now().Format("Jan 2 3:04 PM"), fmt.Sprintf(format, a...))
}

func ask(prompt, def string) string {
	if def != "" {
		fmt.Printf("%s [%s]: ", prompt, def)
	} else {
		fmt.Printf("%s: ", prompt)
	}
	line, _ := in.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

func loadConfig() {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	dir = filepath.Join(dir, "MysticDragonsCompanion")
	os.MkdirAll(dir, 0o755)
	cfgPath = filepath.Join(dir, "config.json")
	if b, err := os.ReadFile(cfgPath); err == nil {
		json.Unmarshal(b, &cfg)
	}
	if cfg.Uploaded == nil {
		cfg.Uploaded = map[string]string{}
	}
	if cfg.Warned == nil {
		cfg.Warned = map[string]string{}
	}
}

func saveConfig() {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(cfgPath, b, 0o600)
}

// The game folder for WoW: Forever: the one holding Interface\AddOns and WTF.
func findWow() string {
	var guesses []string
	for _, drive := range []string{"C", "D", "E", "F", "G"} {
		guesses = append(guesses,
			drive+`:\Program Files (x86)\World of Warcraft\_forever_`,
			drive+`:\Program Files\World of Warcraft\_forever_`,
			drive+`:\World of Warcraft\_forever_`,
			drive+`:\Games\World of Warcraft\_forever_`,
		)
	}
	for _, g := range guesses {
		if isWow(g) {
			return g
		}
	}
	return ""
}

func isWow(p string) bool {
	st, err := os.Stat(filepath.Join(p, "Interface", "AddOns"))
	return err == nil && st.IsDir()
}

func normalizeWow(p string) string {
	p = strings.Trim(strings.TrimSpace(p), `"`)
	if isWow(p) {
		return p
	}
	if isWow(filepath.Join(p, "_forever_")) {
		return filepath.Join(p, "_forever_")
	}
	return ""
}

type apiError struct {
	Status int
	Msg    string
	Login  bool
}

func (e *apiError) Error() string { return e.Msg }

func call(route string, body map[string]any, out any) error {
	if body == nil {
		body = map[string]any{}
	}
	body["device"] = "companion"
	if route != "officer/login" {
		body["token"] = cfg.Token
	}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", strings.TrimRight(cfg.Site, "/")+"/api/"+route, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "MysticDragonsCompanion/"+version)
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach the site (%v)", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	json.Unmarshal(raw, &m)
	if res.StatusCode >= 300 {
		msg, _ := m["error"].(string)
		if msg == "" {
			msg = fmt.Sprintf("the site answered %d", res.StatusCode)
		}
		needs, _ := m["needsLogin"].(bool)
		return &apiError{res.StatusCode, msg, needs}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func login() bool {
	fmt.Println()
	fmt.Println("Log in with the officer password (the same one as Officer tools on the site).")
	cfg.Name = ask("Your name (shows in the site's paper trail)", cfg.Name)
	pw := ask("Officer password", "")
	var r struct {
		Token string `json:"token"`
		Who   string `json:"who"`
	}
	if err := call("officer/login", map[string]any{"name": cfg.Name + " (companion app)", "password": pw}, &r); err != nil {
		say("Login failed: %v", err)
		return false
	}
	cfg.Token = r.Token
	saveConfig()
	say("Logged in as %s.", r.Who)
	return true
}

func setup() {
	fmt.Println("Mystic Dragons companion app " + version)
	fmt.Println("Keeps the in-game bidding addon and the site in sync. Leave this window open while you play.")
	fmt.Println()
	if cfg.Site == "" || cfg.WowPath == "" || cfg.Token == "" {
		cfg.Site = ask("Site address", firstNonEmpty(cfg.Site, "https://mysticdragons.org"))
		if !strings.HasPrefix(cfg.Site, "http") {
			cfg.Site = "https://" + cfg.Site
		}
		for cfg.WowPath == "" {
			guess := findWow()
			p := normalizeWow(ask(`WoW: Forever folder (the _forever_ folder inside World of Warcraft)`, guess))
			if p == "" {
				fmt.Println("  That folder doesn't have Interface\\AddOns in it. Try again.")
				continue
			}
			cfg.WowPath = p
		}
		saveConfig()
		for cfg.Token == "" {
			if !login() {
				if strings.ToLower(ask("Try again? (y/n)", "y")) != "y" {
					os.Exit(1)
				}
			}
		}
	}
	say("Site: %s", cfg.Site)
	say("Game folder: %s", cfg.WowPath)
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

// 1) Sheet from the site into the helper addon.
func syncSheet() error {
	var r struct {
		Text       string `json:"text"`
		People     int    `json:"people"`
		ApprovedAt string `json:"approvedAt"`
	}
	if err := call("officer/dkp-addon-sheet", nil, &r); err != nil {
		return err
	}
	if !strings.HasPrefix(r.Text, "MDKP1:") {
		return errors.New("the site sent something that isn't a sheet")
	}
	dir := filepath.Join(cfg.WowPath, "Interface", "AddOns", "MysticDragonsBids_Inbox")
	if r.Text == cfg.Sheet {
		if _, err := os.Stat(filepath.Join(dir, "Inbox.lua")); err == nil {
			return nil
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	toc := "## Interface: 16001\n## Title: Mystic Dragons Bids (sheet)\n## Notes: Written by the Mystic Dragons companion app. Don't edit.\n\nInbox.lua\n"
	lua := "-- Written by the Mystic Dragons companion app " + time.Now().Format(time.RFC3339) + ". Don't edit.\nMDBidsInbox = " + luaString(r.Text) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "MysticDragonsBids_Inbox.toc"), []byte(toc), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "Inbox.lua"), []byte(lua), 0o644); err != nil {
		return err
	}
	cfg.Sheet = r.Text
	saveConfig()
	when := "nothing approved yet"
	if t, err := time.Parse(time.RFC3339, r.ApprovedAt); err == nil {
		when = "approved " + t.Local().Format("Jan 2 3:04 PM")
	}
	say("New sheet ready for the addon: %d people, %s. It loads at your next login or /reload.", r.People, when)
	return nil
}

func luaString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", "")
	return `"` + r.Replace(s) + `"`
}

var exportRe = regexp.MustCompile(`\["export"\]\s*=\s*"((?:[^"\\]|\\.)*)"`)

// 2) Results from the game's saved variables to the site.
func syncResults() error {
	files, _ := filepath.Glob(filepath.Join(cfg.WowPath, "WTF", "Account", "*", "SavedVariables", "MysticDragonsBids.lua"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		m := exportRe.FindSubmatch(b)
		if m == nil {
			continue
		}
		text := strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(string(m[1]))
		sum := sha1.Sum([]byte(text))
		h := hex.EncodeToString(sum[:])
		if cfg.Uploaded[f] == h {
			continue
		}
		var r struct {
			Added    int      `json:"added"`
			Skipped  int      `json:"skipped"`
			Problems []string `json:"problems"`
		}
		if err := call("officer/dkp-addon-import", map[string]any{"text": text}, &r); err != nil {
			return err
		}
		if r.Added > 0 {
			say("Sent %d loot award(s) to the site as drafts (%d were already there).", r.Added, r.Skipped)
		}
		if len(r.Problems) == 0 {
			cfg.Uploaded[f] = h // done with this export
		} else if cfg.Warned[f] != h {
			// Keep retrying quietly (fixed on the site = added next round); say what's wrong once.
			for _, p := range r.Problems {
				say("  Couldn't add one yet: %s", p)
			}
			cfg.Warned[f] = h
		}
		saveConfig()
	}
	return nil
}

func round() {
	for _, step := range []func() error{syncSheet, syncResults} {
		if err := step(); err != nil {
			var ae *apiError
			if errors.As(err, &ae) && (ae.Login || ae.Status == 401) {
				say("The officer login expired.")
				cfg.Token = ""
				for cfg.Token == "" {
					login()
				}
				return
			}
			say("Problem: %v. Trying again in a couple of minutes.", err)
			return
		}
	}
}

func main() {
	once := flag.Bool("once", false, "sync once and quit")
	reset := flag.Bool("reset", false, "forget the saved settings and set up again")
	flag.Parse()
	loadConfig()
	if *reset {
		cfg = Config{Uploaded: map[string]string{}, Warned: map[string]string{}}
		saveConfig()
	}
	setup()
	round()
	if *once {
		return
	}
	say("Watching. Results go up a minute or two after you log out or /reload. Close this window to stop.")
	for range time.Tick(2 * time.Minute) {
		round()
	}
}
