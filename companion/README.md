# Mystic Dragons companion app

One officer runs this on their Windows PC while they play. It keeps the bidding addon and the site in sync:

- **Sheet in:** every 2 minutes it gets the latest approved DKP sheet from the site and saves it into a small
  helper addon (`MysticDragonsBids_Inbox`). The bidding addon loads it at the next login or `/reload` and shares it
  with everyone online. No more `/mdkp import`.
- **Results out:** when the game saves (logout or `/reload`), it sends the addon's loot results to the site as draft
  awards. No more `/mdkp export` and paste. Results already on the site are skipped.

## Use
1. Run `MysticDragonsCompanion.exe`. Windows will say "Windows protected your PC" the first time (it isn't
   code-signed): More info → Run anyway.
2. First run asks for the site address, your WoW: Forever folder (it guesses), your name and the officer password.
   Settings are saved in `%APPDATA%\MysticDragonsCompanion\config.json`.
3. Leave the window open while you play. Close it to stop.

`MysticDragonsCompanion.exe -reset` starts setup over. `-once` syncs once and quits.

To start it with Windows: press Win+R, type `shell:startup`, and put a shortcut to the exe in that folder.

## Build
`GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o MysticDragonsCompanion.exe`
