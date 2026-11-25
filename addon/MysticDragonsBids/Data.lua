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
    return { sheet = nil, results = {}, seq = 0, opts = { minQuality = 4, lastCall = 30 }, errors = {} }
end

function D.Init()
    MDBidsDB = type(MDBidsDB) == "table" and MDBidsDB or defaults()
    local db = MDBidsDB
    for k, v in pairs(defaults()) do if db[k] == nil then db[k] = v end end
    D.db = db
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
    return true
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
    for _, r in ipairs(D.db.results) do
        if r.sheet == s.at and r.person == person and not r.undone then bal = bal - (r.price or 0) end
    end
    return math.max(0, bal)
end

-- Record an award. Returns the result row.
function D.AddResult(r)
    D.db.seq = (D.db.seq or 0) + 1
    r.seq, r.at = D.db.seq, r.at or C.Now()
    r.sheet = D.db.sheet and D.db.sheet.at or ""
    r.person = D.PersonOf(r.winner)
    table.insert(D.db.results, r)
    return r
end

-- Results not yet confirmed as imported by the site (all of them, until /mdkp clear).
local function clean(s) return (tostring(s or ""):gsub("[=;#,\n|]", " ")) end
function D.ExportString()
    local rows = {}
    for _, r in ipairs(D.db.results) do
        if not r.undone and not r.test then
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
    local kept, cur = {}, D.db.sheet and D.db.sheet.at or ""
    for _, r in ipairs(D.db.results) do if r.sheet == cur and not r.test then kept[#kept + 1] = r end end
    local dropped = #D.db.results - #kept
    D.db.results = kept
    return dropped
end

function D.LogError(msg)
    local e = D.db and D.db.errors
    if not e then return end
    table.insert(e, 1, { at = C.Now(), msg = tostring(msg) })
    while #e > 30 do table.remove(e) end
end
