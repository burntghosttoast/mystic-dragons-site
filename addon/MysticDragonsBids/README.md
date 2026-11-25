# Mystic Dragons Bids

DKP bidding for Mystic Dragons on WoW: Forever.

## Install
Put the `MysticDragonsBids` folder in `World of Warcraft\_forever_\Interface\AddOns\` and restart the game (or /reload).

## Commands
- `/mdkp` your DKP
- `/mdkp test` practice alone: 4 fake items, 3 fake bidders
- `/mdkp test group` practice with your group: everyone with the addon gets the bid window
- `/mdkp import` (officers) paste the sheet from the site: Officer tools → DKP → Copy sheet for the addon
- `/mdkp export` (loot masters) copy tonight's results, then on the site: Paste results from the addon
- `/mdkp show` reopen the windows
- `/mdkp check` what works on this game patch
- `/mdkp clear` forget results the site already has
- `/mdkp keep 120` how many days of old results to keep on this PC (default 120, about a raid tier)

## How a night works
1. An officer imports the approved sheet once. It spreads to everyone online with the addon.
2. The loot master opens the loot (master loot). Bidding opens on every epic at once.
3. Raiders bid in the bid window, or whisper the loot master `[item] 15` or `pass`.
4. Per item the loot master presses Last call, then Award. Ties rebid. No bids: roll it off, then type the winner and Give.
   Live auction sets an item aside; when the rest is done, Start live runs an open auction (each bid beats the last, Going once, Going twice, Sold).
5. After raid: `/mdkp export`, paste on the site, approve the sheet as usual.

## Rules it follows
Minimum bid 1. You can't bid more than you can spend. Points from tonight don't count until the next approved sheet.
New raiders can't spend on their first night (except the guild's very first raid, when everyone starts with 20).
The loot master can't see an item's bids until they've bid or passed on it.
