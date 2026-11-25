-- Mystic Dragons Bids: hidden addon messages between players.
--
--   HELLO:<version>:<sheet at>     GUILD, at login. Lets people see a newer version exists, and lets an
--                                  officer with a newer sheet send it.
--   SH:<part>/<total>:<check>:<text>  GUILD, a sheet in pieces (check = the sheet's own checksum).
--                                  Only taken from officers (guild rank 0 or 1), and only if newer.
--   O:<sid>:<idx>=<itemId>,...     RAID, loot master opened bidding.
--   B:<sid>:<idx>:<amount>         WHISPER to the loot master, a bid.     P:<sid>:<idx> a pass.
--   OK:<sid>:<idx>:<amount>        WHISPER back, bid taken.               NO:<sid>:<idx>:<why> bid refused.
--   LC:<sid>:<idx>:<seconds>       RAID, last call.
--   RB:<sid>:<idx>:<name>/<name>   RAID, tie: only these people rebid.
--   W:<sid>:<idx>:<winner>:<price> RAID, item awarded (price 0 and winner "-" = rolled off / nobody).
--   X:<sid>                        RAID, bidding over.
local _, ns = ...
local C = ns.C
local M = {}
ns.M = M

local parts = {}      -- sheet pieces being put back together, by sender
local seenNewer = nil -- a newer version someone has, told once

function M.Send(msg, channel, target)
    local ok, why = C.SendAddon(msg, channel, target)
    if not ok and why == "lockdown" then
        -- Mid boss fight: try again shortly.
        C.After(3, function() C.SendAddon(msg, channel, target) end)
    end
    return ok
end

function M.Hello()
    local s = ns.D.db.sheet
    M.Send("HELLO:" .. C.VERSION .. ":" .. (s and s.at or ""), "GUILD")
end

local function newerVersion(v)
    local a = { (v or ""):match("(%d+)%.(%d+)%.(%d+)") }
    local b = { C.VERSION:match("(%d+)%.(%d+)%.(%d+)") }
    for i = 1, 3 do
        local x, y = tonumber(a[i]) or 0, tonumber(b[i]) or 0
        if x ~= y then return x > y end
    end
    return false
end

-- Send the sheet to the guild in pieces of about 200 characters.
function M.SendSheet()
    local s = ns.D.db.sheet
    if not (s and s.raw) then return end
    local text, size, n = s.raw, 200, 0
    local sum = text:match("#(%d+)$") or "0"
    local total = math.ceil(#text / size)
    for i = 1, total do
        local piece = text:sub((i - 1) * size + 1, i * size)
        C.After(i * 0.4, function() M.Send("SH:" .. i .. "/" .. total .. ":" .. sum .. ":" .. piece, "GUILD") end)
        n = n + 1
    end
    return n
end

local function onSheetPart(sender, msg)
    local i, total, at, piece = msg:match("^SH:(%d+)/(%d+):(%d+):(.*)$")
    i, total = tonumber(i), tonumber(total)
    if not (i and total and total < 80) then return end
    local cur = ns.D.db.sheet
    if cur and cur.raw and cur.raw:match("#(%d+)$") == at then return end
    local rank = C.GuildRankOf(sender)
    if not (rank and rank <= 1) then return end
    local p = parts[sender]
    if not p or p.at ~= at then p = { at = at, got = {}, n = 0 }; parts[sender] = p end
    if not p.got[i] then p.got[i] = piece; p.n = p.n + 1 end
    if p.n == total then
        local text = table.concat(p.got, "", 1, total)
        parts[sender] = nil
        local sheet = ns.D.ParseSheet(text)
        if sheet and ns.D.SetSheet(sheet) then
            sheet.raw = text
            ns.Print("Got the latest DKP sheet (approved " .. ns.When(sheet.at) .. ") from " .. sender .. ".")
            if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        end
    end
end

function M.OnMessage(prefix, msg, channel, sender)
    if prefix ~= C.PREFIX or C.IsSecret(msg, sender) then return end
    sender = C.Norm(sender)
    if not sender or not msg then return end
    local me = C.PlayerName()
    local kind = msg:match("^(%u+):")
    if kind == "HELLO" then
        local v, at = msg:match("^HELLO:([^:]*):(.*)$")
        if v and newerVersion(v) and seenNewer ~= v then
            seenNewer = v
            ns.Print("A newer version (" .. v .. ") is out. Update through WowUp or the site's Addons page.")
        end
        -- An officer with a newer sheet sends it, once, after a short random wait.
        local s = ns.D.db.sheet
        local rank = C.MyGuildRank()
        if s and s.raw and rank and rank <= 1 and (at or "") < (s.at or "") and sender ~= me then
            if not M.sending then
                M.sending = true
                C.After(1 + math.random() * 4, function() M.SendSheet(); C.After(30, function() M.sending = false end) end)
            end
        end
    elseif kind == "SH" then
        if sender ~= me then onSheetPart(sender, msg) end
    elseif kind == "B" or kind == "P" then
        if ns.A then ns.A.OnAddonBid(sender, msg) end
    else
        if sender ~= me or kind == "O" or kind == "W" or kind == "LC" or kind == "RB" or kind == "X" then
            if ns.B then ns.B.OnMessage(sender, kind, msg) end
        end
    end
end
