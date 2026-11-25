-- Mystic Dragons Bids: saved data, the approved sheet, balances and results.
--
-- The approved sheet comes from the site (Officer tools → DKP → Copy for the addon):
--   MDKP1:at=<when approved>,by=<officer>,start=<starting DKP>,first=<1 if no raid yet>#Name=balance=Alt/Alt;...#<check>
-- Results go back to the site (/mdkp export):
--   MDKPR1:lm=<loot master>,v=<version>,n=<count>#seq=time=itemId=item name=winner=price=kind;...#<check>
-- <check> is a simple sum of the bytes between the two #, so a cut-off paste is caught.
local _, ns = ...
local C = ns.C
local D = {}
ns.D = D

local function defaults()
    return { sheet = nil, results = {}, log = {}, seq = 0, opts = { minQuality = 4, lastCall = 30, keepDays = 120 }, errors = {} }
end

function D.Init()
    MDBidsDB = type(MDBidsDB) == "table" and MDBidsDB or defaults()
    local db = MDBidsDB
    for k, v in pairs(defaults()) do if db[k] == nil then db[k] = v end end
    for k, v in pairs(defaults().opts) do if db.opts[k] == nil then db.opts[k] = v end end
    D.db = db
    -- The companion app drops the newest approved sheet into a small helper addon
    -- (MysticDragonsBids_Inbox) as MDBidsInbox. Take it if it's newer than the one we have.
    if type(MDBidsInbox) == "string" then
        local sheet = D.ParseSheet(MDBidsInbox)
        if sheet and D.SetSheet(sheet) then D.fromInbox = true end
    end
end

local function check(body)
    local sum = 0
    for i = 1, #body do sum = (sum * 31 + body:byte(i)) % 1000003 end
    return tostring(sum)
end
D.Checksum = check

local function header(s)
    local h = {}
    for k, v in s:gmatch("([%w]+)=([^,]*)") do h[k] = v end
    return h
end

-- Parse a sheet string. Returns the sheet table, or nil and a reason.
function D.ParseSheet(text)
    if type(text) ~= "string" then return nil, "Nothing to import." end
    text = text:gsub("%s*\n%s*", ""):gsub("^%s+", ""):gsub("%s+$", "")
    local head, body, sum = text:match("^MDKP1:([^#]*)#(.*)#(%d+)$")
    if not head then return nil, "That isn't a sheet from the site. Copy it again from Officer tools → DKP." end
    if check(body) ~= sum then return nil, "The sheet got cut off or changed while copying. Copy it again." end
    local h = header(head)
    local sheet = { raw = text, at = h.at or "", by = h.by or "", start = tonumber(h.start) or 20, first = h.first == "1", bal = {}, person = {}, display = {}, alts = {} }
    for rec in body:gmatch("[^;]+") do
        local name, bal, alts = rec:match("^([^=]+)=(%-?%d+)=?(.*)$")
        local key = C.Key(name)
        if key then
            sheet.bal[key] = tonumber(bal) or 0
            sheet.display[key] = C.Norm(name)
            sheet.person[key] = key
            sheet.alts[key] = {}
            for alt in (alts or ""):gmatch("[^/]+") do
                local ak = C.Key(alt)
                if ak then sheet.person[ak] = key; table.insert(sheet.alts[key], C.Norm(alt)) end
            end
        end
    end
    return sheet
end

-- Replace the sheet. Keeps it only if it's newer than the one already here (unless forced).
function D.SetSheet(sheet, force)
    local cur = D.db.sheet
    if cur and not force and (cur.at or "") >= (sheet.at or "") then return false end
    D.db.sheet = sheet
    D.Prune()
    return true
end

-- Results older than the current sheet are already counted on the site. Keep a raid tier's worth
-- (120 days by default, change with /mdkp keep <days>), then drop the oldest so the saved file can't grow forever.
function D.Prune()
    local cut = D.IsoToUnix(D.db.sheet and D.db.sheet.at)
    if cut == 0 then return 0 end
    local kept, keep = {}, (tonumber(D.db.opts.keepDays) or 120) * 86400
    for _, r in ipairs(D.db.results) do
        if (r.at or 0) > cut - keep then kept[#kept + 1] = r end
    end
    local dropped = #D.db.results - #kept
    D.db.results = kept
    for k, r in pairs(D.db.log) do if (r.at or 0) <= cut - keep then D.db.log[k] = nil end end
    if D.RefreshExport then D.RefreshExport() end
    return dropped
end

-- The person a character belongs to (main + alts share one balance).
function D.PersonOf(name)
    local key = C.Key(name)
    if not key then return nil end
    local s = D.db.sheet
    return s and s.person[key] or key
end
function D.DisplayName(person)
    local s = D.db.sheet
    return s and s.display[person] or person
end

-- "2026-12-10T15:00:00Z" to seconds since 1970 (UTC). 0 if it can't be read.
function D.IsoToUnix(iso)
    local y, m, d, hh, mm, ss = tostring(iso or ""):match("^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+):(%d+)")
    if not y then return 0 end
    y, m, d = tonumber(y), tonumber(m), tonumber(d)
    if m <= 2 then y = y - 1; m = m + 12 end
    local days = 365 * y + math.floor(y / 4) - math.floor(y / 100) + math.floor(y / 400) + math.floor((153 * (m - 3) + 2) / 5) + d - 719469
    return days * 86400 + tonumber(hh) * 3600 + tonumber(mm) * 60 + tonumber(ss)
end

-- Results that come off balances: anything won after the sheet was approved (the sheet can't include
-- those yet). Re-importing the same or a re-copied sheet mid-raid doesn't give DKP back.
local function after(r, s) return (r.at or 0) > D.IsoToUnix(s and s.at) end

-- What a person can spend tonight: the approved sheet, minus anything already won since it was approved.
-- On the guild's very first raid night (first=1), anyone not on the sheet has the starting DKP.
-- Otherwise someone not on the sheet is new, and new raiders can't spend on their first night.
function D.Spendable(name)
    local s, person = D.db.sheet, D.PersonOf(name)
    local testing = ns.A and ns.A.session and ns.A.session.test and not ns.A.session.ended
    local bal = s and person and s.bal[person]
    if bal == nil then
        if testing then bal = 100                       -- practice: everyone has 100 if they aren't on the sheet
        elseif not s or not person then return 0, "No sheet loaded yet. An officer needs to import it (/mdkp import)."
        elseif s.first then bal = s.start
        else return 0, "New raiders can't spend DKP until their second raid." end
    end
    s = s or { at = "" }
    -- Every loot master's awards since the sheet (mine, plus the ones other loot masters' addons shared).
    for _, r in ipairs(D.AllAwards()) do
        if after(r, s) and r.person == person and not r.undone then bal = bal - (r.price or 0) end
    end
    return math.max(0, bal)
end

-- Awards other loot masters' addons shared with this one, keyed "loot master|seq".
-- Officers and loot masters keep everyone's; raiders keep only their own (DKP is private to the person and officers).
function D.IsOfficer() local rank = C.MyGuildRank(); return (rank and rank <= 1) or false end
function D.CanSeeAll()
    local rank = C.MyGuildRank()
    return (rank and rank <= 1) or D.db.isLM or false
end
function D.LogAward(rec)
    if not (rec and rec.lm and rec.seq) then return end
    rec.person = D.PersonOf(rec.winner)
    if not D.CanSeeAll() and rec.person ~= D.PersonOf(C.PlayerName()) then return end
    if C.Key(rec.lm) == C.Key(C.PlayerName()) then return end -- my own are in results already
    local key = C.Key(rec.lm) .. "|" .. rec.seq
    local had = D.db.log[key]
    if had and had.undone and not rec.undone then return end
    D.db.log[key] = rec
end
function D.UndoLogged(lm, seq)
    local rec = D.db.log[(C.Key(lm) or "") .. "|" .. tostring(seq)]
    if rec then rec.undone = true end
end

-- Every award this addon knows about, newest first: { lm, seq, at, itemId, itemName, winner, person, price, kind, undone, mine }
function D.AllAwards()
    local out, me = {}, C.PlayerName()
    for _, r in ipairs(D.db.results) do
        if not r.test then
            out[#out + 1] = { lm = me, seq = r.seq, at = r.at, itemId = r.itemId, itemName = r.itemName, winner = r.winner,
                              person = r.person, price = r.price, kind = r.kind, undone = r.undone, mine = true }
        end
    end
    for _, r in pairs(D.db.log) do local c = {}; for k, v in pairs(r) do c[k] = v end; out[#out + 1] = c end
    table.sort(out, function(a, b) return (a.at or 0) > (b.at or 0) end)
    return out
end

-- Record an award. Returns the result row.
function D.AddResult(r)
    D.db.seq = (D.db.seq or 0) + 1
    r.seq, r.at = D.db.seq, r.at or C.Now()
    r.sheet = D.db.sheet and D.db.sheet.at or ""
    r.person = D.PersonOf(r.winner)
    table.insert(D.db.results, r)
    D.RefreshExport()
    return r
end

-- The companion app reads this from the saved variables after a logout or /reload.
function D.RefreshExport()
    local text, n = D.ExportString()
    D.db.export = n > 0 and text or nil
end

-- Results not yet confirmed as imported by the site (all of them, until /mdkp clear).
local function clean(s) return (tostring(s or ""):gsub("[=;#,\n|]", " ")) end
function D.ExportString()
    -- Only the last 30 days go in the export: older ones are on the site already, and this keeps uploads small.
    local rows, since = {}, C.Now() - 30 * 86400
    for _, r in ipairs(D.db.results) do
        if not r.undone and not r.test and (r.at or 0) > since then
            rows[#rows + 1] = table.concat({ r.seq, r.at, r.itemId or 0, clean(r.itemName), clean(r.winner), r.price or 0, r.kind or "bid" }, "=")
        end
    end
    local body = table.concat(rows, ";")
    local head = "lm=" .. clean(C.PlayerName()) .. ",v=" .. C.VERSION .. ",n=" .. #rows
    return "MDKPR1:" .. head .. "#" .. body .. "#" .. check(body), #rows
end

-- Drop results the site already has: anything won before the current sheet was approved.
-- Tonight's stay, because they still come off people's balances until the next sheet.
-- Exporting the same result twice is harmless: the site skips ones it already has.
function D.ClearResults()
    local kept = {}
    for _, r in ipairs(D.db.results) do if after(r, D.db.sheet) and not r.test then kept[#kept + 1] = r end end
    local dropped = #D.db.results - #kept
    D.db.results = kept
    D.RefreshExport()
    return dropped
end

function D.LogError(msg)
    local e = D.db and D.db.errors
    if not e then return end
    table.insert(e, 1, { at = C.Now(), msg = tostring(msg) })
    while #e > 30 do table.remove(e) end
end
