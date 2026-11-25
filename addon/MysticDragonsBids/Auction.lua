-- Mystic Dragons Bids: the loot master's side.
--
-- Opening the loot (master loot, you're the loot master) opens bidding on every item at once.
-- Raiders bid in their popup or by whisper ("[item] 25", "pass"). Minimum bid is 1, nobody can bid more
-- than they can spend. Per item the loot master has: Last call, Award (top bid wins and pays it; a tie
-- makes the tied people rebid), Roll it off when nobody bid, and Live auction: the item is set aside
-- until the rest of the loot is done, then gets its own open, out-loud auction (everyone sees the high bid,
-- each bid has to beat it, Going once / Going twice / Sold).
-- The loot master bids like everyone else, and can't see an item's bids until they've bid or passed on it.
-- Whispers that are bids are held out of the loot master's chat until then, and shown after.
local _, ns = ...
local C, D, M = ns.C, ns.D, ns.M
local A = {}
ns.A = A

A.session = nil
A.replies = {}   -- whisper replies waiting for a click (Forever drops chat sent without one)

local TAG = "[MD Bids auto-reply] "

local function item(idx) return A.session and A.session.items[idx] end
local function linkOf(it) return it.link or it.name or ("item " .. tostring(it.itemId)) end

-- Queue a whisper reply. It goes out on the loot master's next click in the window.
local function reply(to, text)
    table.insert(A.replies, { to = to, text = TAG .. text })
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

-- Send what's waiting. Call only from a click. Sends at most 8 at once to stay under the whisper limit.
function A.Flush()
    local n = 0
    while #A.replies > 0 and n < 8 do
        local r = table.remove(A.replies, 1)
        C.SendChat(r.text, "WHISPER", r.to)
        n = n + 1
    end
    return n
end

-- Announce to the raid. Only from a click.
local function announce(text) C.SendChat(text, "RAID_WARNING") end

local function newId() return tostring(C.Now() % 100000) .. tostring(math.random(10, 99)) end

-- items: list of { itemId, link?, slot? }
function A.Start(items, opts)
    opts = opts or {}
    if A.session and not A.session.ended then return false, "Bidding is already open. End it first." end
    local s = { sid = newId(), items = {}, test = opts.test, solo = opts.solo, started = C.Now() }
    local wire = {}
    for i, it in ipairs(items) do
        local name, link = C.ItemInfo(it.link or it.itemId)
        s.items[i] = { idx = i, itemId = it.itemId or C.ItemIdFromLink(it.link), link = it.link or link, name = name, slot = it.slot,
                       bids = {}, passes = {}, held = {}, state = "open" }
        wire[#wire + 1] = i .. "=" .. tostring(s.items[i].itemId or 0)
    end
    A.session = s
    if not opts.solo then M.Send("O:" .. s.sid .. ":" .. table.concat(wire, ","), C.GroupChannel() or "WHISPER", C.PlayerName()) end
    if ns.B then ns.B.Open(C.PlayerName(), s.sid, s.items, true) end
    if ns.UI then ns.UI.ShowLM() end
    return true
end

-- Loot window opened. If I'm the loot master, open bidding on everything at or above the quality setting.
function A.OnLootReady()
    if not C.IsMasterLooter() or not C.InGroup() then return end
    local items, seen = {}, {}
    for slot = 1, C.NumLootItems() do
        local link, quality = C.LootSlot(slot)
        if link and (quality or 0) >= (D.db.opts.minQuality or 4) then
            items[#items + 1] = { link = link, itemId = C.ItemIdFromLink(link), slot = slot }
            seen[#seen + 1] = link
        end
    end
    if #items == 0 then return end
    -- Same loot window reopened: keep the session, just refresh which slot each item is in.
    if A.session and not A.session.ended then
        for _, it in ipairs(A.session.items) do
            for _, new in ipairs(items) do if new.link == it.link and not new.taken then it.slot = new.slot; new.taken = true; break end end
        end
        return
    end
    A.Start(items)
end

local function inGroup(name)
    if A.session and (A.session.test or A.session.solo) then return true end
    local list, ok = C.GroupNames()
    return (not ok) or list[C.Key(name)] ~= nil
end

-- A bid or pass from anyone (addon popup, whisper, or the loot master's own popup).
-- amount = number, or "pass". via = "addon" | "whisper" | "self". Returns ok, message.
function A.Bid(sender, sid, idx, amount, via)
    local s = A.session
    local it = item(idx)
    local function no(why)
        if via == "test" then return false, why end
        if via == "addon" then M.Send("NO:" .. tostring(sid) .. ":" .. tostring(idx) .. ":" .. why, "WHISPER", sender)
        elseif via == "whisper" then reply(sender, why) end
        return false, why
    end
    if not s or s.ended or (sid and sid ~= s.sid) or not it then return no("Bidding isn't open on that.") end
    if it.state == "done" then return no((it.link and it.link or "That item") .. " is already awarded.") end
    if it.state == "later" then return no(linkOf(it) .. " is saved for a live auction after the rest of the loot.") end
    if it.state == "roll" then return no(linkOf(it) .. " is being rolled off.") end
    if not inGroup(sender) then return no("You need to be in the raid to bid.") end
    local person = D.PersonOf(sender)
    if it.state == "tie" and not it.tied[person] then return no("Only the tied bidders can bid on " .. linkOf(it) .. " right now.") end
    if it.state == "live" then
        amount = tonumber(amount)
        local high = it.high and it.high.amount or 0
        if amount == nil or amount ~= math.floor(amount) then return no("Bid a whole number, like 15.") end
        if amount <= high then return no("The high bid is " .. high .. ". Bid more than that.") end
        if amount < 1 then return no("The minimum bid is 1.") end
        local can, why = D.Spendable(sender)
        if via == "test" then can, why = 100, nil end
        if why then return no(why) end
        if amount > can then return no("You only have " .. can .. " DKP to spend.") end
        it.high = { person = person, name = C.Norm(sender), amount = amount }
        table.insert(it.history, 1, it.high)
        it.going = 0
        local msg = "LH:" .. s.sid .. ":" .. idx .. ":" .. amount .. ":" .. it.high.name
        M.Send(msg, C.GroupChannel())
        if ns.B then ns.B.OnMessage(C.PlayerName(), "LH", msg) end
        if via == "whisper" then reply(sender, "You're the high bid on " .. linkOf(it) .. " at " .. amount .. ".") end
        if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        return true
    end
    if amount == "pass" then
        it.bids[person], it.passes[person] = nil, sender
        if via == "addon" then M.Send("OK:" .. s.sid .. ":" .. idx .. ":pass", "WHISPER", sender)
        elseif via == "whisper" then reply(sender, "Passed on " .. linkOf(it) .. ".") end
    else
        amount = tonumber(amount)
        if not amount or amount ~= math.floor(amount) then return no("Bid a whole number, like 15.") end
        if amount < 1 then return no("The minimum bid is 1. Say pass if you don't want it.") end
        if it.state == "tie" and amount < it.tieAt then return no("Rebid at least " .. it.tieAt .. ".") end
        local can, why = D.Spendable(sender)
        if via == "test" then can, why = 100, nil end
        if why then return no(why) end
        if amount > can then return no("You only have " .. can .. " DKP to spend.") end
        it.passes[person] = nil
        it.bids[person] = { name = C.Norm(sender), amount = amount, at = C.Now(), via = via }
        if via == "addon" then M.Send("OK:" .. s.sid .. ":" .. idx .. ":" .. amount, "WHISPER", sender)
        elseif via == "whisper" then reply(sender, "Got your bid of " .. amount .. " on " .. linkOf(it) .. ". You have " .. can .. " to spend.") end
    end
    if via == "self" then A.Decided(idx) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
    return true
end

-- The loot master has bid or passed on an item: show its bids, and the held whispers in chat.
function A.Decided(idx)
    local it = item(idx)
    if not it or it.lmDecided then return end
    it.lmDecided = true
    for _, w in ipairs(it.held) do ns.EchoWhisper(w.sender, w.text) end
    it.held = {}
end

function A.OnAddonBid(sender, msg)
    if not (A.session and C.PlayerName() and A.IsMine()) then return end
    local kind, sid, idx, amt = msg:match("^(%u):([^:]+):(%d+):?(.*)$")
    if kind == "P" then A.Bid(sender, sid, tonumber(idx), "pass", "addon")
    elseif kind == "B" then A.Bid(sender, sid, tonumber(idx), tonumber(amt), "addon") end
end
function A.IsMine() return A.session ~= nil and not A.session.ended end

-- Which open item a whisper means: an item link in it, or the only open item.
local function whichItem(text)
    local s = A.session
    local id = C.ItemIdFromLink(text)
    local open = {}
    for _, it in ipairs(s.items) do if it.state == "live" then if not id or it.itemId == id then return it end end end
    for _, it in ipairs(s.items) do if it.state == "open" or it.state == "tie" then open[#open + 1] = it end end
    if id then for _, it in ipairs(open) do if it.itemId == id then return it end end return nil, "That item isn't up for bids." end
    if #open == 1 then return open[1] end
    return nil, "Several items are up. Whisper the item link with your bid, like [item] 15."
end

-- A whisper to the loot master. Returns true if it was a bid (so the chat filter can hold it).
function A.OnWhisper(sender, text)
    if not A.IsMine() or C.IsSecret(sender, text) or type(text) ~= "string" then return false end
    if text:find(TAG, 1, true) then return false end
    local stripped = text:gsub("|c%x+|H.-|h.-|h|r", ""):lower()
    local amount = stripped:match("^%s*(%d+)%s*$") or stripped:match("^%s*bid%s+(%d+)%s*$")
    local pass = stripped:match("^%s*pass%s*$")
    local hasLink = C.ItemIdFromLink(text) ~= nil
    if hasLink and not amount and not pass then amount = stripped:match("(%d+)%s*$"); pass = stripped:match("pass") end
    if not amount and not pass then return false end
    local it, why = whichItem(text)
    if not it then reply(sender, why); return false end
    A.Bid(sender, A.session.sid, it.idx, pass and "pass" or tonumber(amount), "whisper")
    if not it.lmDecided then table.insert(it.held, { sender = sender, text = text }); return true end
    return false
end

-- Ranked bids for an item: highest first, then whoever bid first.
function A.Ranked(idx)
    local it, out = item(idx), {}
    if not it then return out end
    for person, b in pairs(it.bids) do out[#out + 1] = { person = person, name = b.name, amount = b.amount, at = b.at } end
    table.sort(out, function(a, b) if a.amount ~= b.amount then return a.amount > b.amount end return a.at < b.at end)
    return out
end

-- Last call: raid warning now, the window counts down. From a click.
function A.LastCall(idx)
    local it = item(idx); if not it or it.state == "done" then return end
    local sec = D.db.opts.lastCall or 30
    it.lcEnd = C.Now() + sec
    A.Flush()
    announce("Last call on " .. linkOf(it) .. ": " .. sec .. " seconds to bid or pass.")
    local msg = "LC:" .. A.session.sid .. ":" .. idx .. ":" .. sec
    M.Send(msg, C.GroupChannel())
    if ns.B then ns.B.OnMessage(C.PlayerName(), "LC", msg) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

local function give(it, winner)
    if A.session.test or not it.slot then return true end
    local ok, why = C.GiveLoot(it.slot, winner)
    if not ok then ns.Print("Couldn't hand over " .. linkOf(it) .. ": " .. why .. " Trade it to " .. winner .. " instead.") end
    return ok
end

local function finish(it, winner, price, kind)
    it.state, it.winner, it.price = "done", winner, price
    if winner ~= "-" then
        give(it, winner)
        local r = D.AddResult({ itemId = it.itemId, itemName = it.name or linkOf(it), winner = winner, price = price, kind = kind, test = A.session.test })
        it.result = r
    end
    M.Send("W:" .. A.session.sid .. ":" .. it.idx .. ":" .. winner .. ":" .. price, C.GroupChannel())
    if ns.B then ns.B.Won(it.idx, winner, price) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

-- Award to the top bid. A tie at the top makes the tied people rebid. From a click.
function A.Award(idx)
    local it = item(idx); if not it or it.state == "done" then return end
    A.Flush()
    local ranked = A.Ranked(idx)
    -- Someone may have spent DKP on another item since bidding: drop bids they can no longer pay.
    local fixed = {}
    for _, r in ipairs(ranked) do
        if (D.Spendable(r.name)) >= r.amount then fixed[#fixed + 1] = r
        else it.bids[r.person] = nil; reply(r.name, "Your bid of " .. r.amount .. " on " .. linkOf(it) .. " was dropped: you don't have that much left.") end
    end
    ranked = fixed
    if #ranked == 0 and it.state == "tie" then
        -- The tied people didn't rebid: they roll for it.
        announce("No rebids on " .. linkOf(it) .. ". " .. table.concat(it.tiedNames, " and ") .. ": roll for it!")
        it.state = "roll"
        if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        return "roll"
    end
    if #ranked == 0 then return A.RollOff(idx) end
    local top = ranked[1].amount
    local tied = {}
    for _, r in ipairs(ranked) do if r.amount == top then tied[#tied + 1] = r end end
    if #tied > 1 then
        -- Forced rebid: everyone's bids are cleared, and only the tied people can bid again.
        it.state, it.tieAt, it.tied, it.lcEnd, it.bids, it.passes = "tie", top, {}, nil, {}, {}
        local names = {}
        for _, r in ipairs(tied) do it.tied[r.person] = true; names[#names + 1] = r.name end
        it.tiedNames = names
        if A.session.test and A.session.solo then
            -- Practice: the fake bidders rebid a couple of seconds later.
            C.After(2, function()
                for _, n in ipairs(names) do
                    if not C.Key(n) or C.Key(n) ~= C.Key(C.PlayerName()) then A.Bid(n, A.session.sid, idx, top + math.random(0, 6), "test") end
                end
            end)
        end
        announce("Tie on " .. linkOf(it) .. " at " .. top .. " between " .. table.concat(names, " and ") .. ". Rebid, at least " .. top .. ".")
        local msg = "RB:" .. A.session.sid .. ":" .. idx .. ":" .. table.concat(names, "/")
        M.Send(msg, C.GroupChannel())
        if ns.B then ns.B.OnMessage(C.PlayerName(), "RB", msg) end
        if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        return "tie"
    end
    local w = ranked[1]
    announce(w.name .. " wins " .. linkOf(it) .. " for " .. w.amount .. " DKP.")
    finish(it, w.name, w.amount, "bid")
    return "won"
end

-- Nobody bid: roll it off. From a click.
function A.RollOff(idx)
    local it = item(idx); if not it or it.state == "done" then return end
    A.Flush()
    announce("No bids on " .. linkOf(it) .. ". Roll it off!")
    it.state = "roll"
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
    return "roll"
end

-- Award by hand: a live auction in voice, a roll, or a fix. Price can be 0. From a click.
function A.ManualAward(idx, name, price, kind)
    local it = item(idx); if not it then return false, "Pick an item." end
    if it.state == "done" then return false, "That item is already given out. Undo it first." end
    name, price = C.Norm(name), tonumber(price) or 0
    if not name then return false, "Type who gets it." end
    if price < 0 or price ~= math.floor(price) then return false, "Price is a whole number, 0 or more." end
    if price > 0 then
        local can, why = D.Spendable(name)
        if why then return false, why end
        if price > can then return false, name .. " only has " .. can .. " DKP to spend." end
    end
    A.Flush()
    announce(name .. " gets " .. linkOf(it) .. (price > 0 and (" for " .. price .. " DKP.") or "."))
    finish(it, name, price, kind or (it.state == "roll" and "roll" or "live"))
    return true
end

-- Take back an award made by mistake (the DKP goes back; the item has to be traded back by hand).
function A.Undo(idx)
    local it = item(idx); if not it or it.state ~= "done" then return end
    if it.result then it.result.undone = true end
    it.state, it.winner, it.price, it.result = "open", nil, nil, nil
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

-- Set an item aside for a live auction after the rest of the loot. Bids on it are dropped.
function A.SaveForLive(idx)
    local it = item(idx); if not it or it.state == "done" then return end
    it.state, it.bids, it.passes, it.lcEnd, it.held = "later", {}, {}, nil, {}
    local msg = "LL:" .. A.session.sid .. ":" .. idx
    M.Send(msg, C.GroupChannel())
    if ns.B then ns.B.OnMessage(C.PlayerName(), "LL", msg) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

-- Start the live auction for one item. From a click.
function A.StartLive(idx)
    local it = item(idx); if not it or it.state == "done" then return end
    for _, other in ipairs(A.session.items) do if other.state == "live" and other ~= it then return false, "Finish the other live auction first." end end
    A.Flush()
    it.state, it.high, it.history, it.going, it.lmDecided = "live", nil, {}, 0, true
    announce("Live auction: " .. linkOf(it) .. "! Bid in the bid window or whisper me a number. Highest bid wins.")
    local msg = "LV:" .. A.session.sid .. ":" .. idx
    M.Send(msg, C.GroupChannel())
    if ns.B then ns.B.OnMessage(C.PlayerName(), "LV", msg) end
    if ns.UI then ns.UI.ShowLive(idx) end
    return true
end

-- Going once, going twice. From a click.
function A.Going(idx)
    local it = item(idx); if not it or it.state ~= "live" then return end
    A.Flush()
    if not it.high then announce("Live auction: " .. linkOf(it) .. ". No bids yet!") return end
    it.going = (it.going or 0) + 1
    announce((it.going == 1 and "Going once: " or "Going twice: ") .. linkOf(it) .. " at " .. it.high.amount .. " to " .. it.high.name .. ".")
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

-- Sold to the high bid (or rolled off when nobody bid). From a click.
function A.Sold(idx)
    local it = item(idx); if not it or it.state ~= "live" then return end
    A.Flush()
    if not it.high then
        announce("No bids on " .. linkOf(it) .. ". Roll it off!")
        it.state = "roll"
        if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        return "roll"
    end
    -- The high bidder might have spent DKP on another item meanwhile.
    if (D.Spendable(it.high.name)) < it.high.amount and not A.session.test then
        return false, it.high.name .. " doesn't have " .. it.high.amount .. " anymore."
    end
    announce("Sold! " .. it.high.name .. " wins " .. linkOf(it) .. " for " .. it.high.amount .. " DKP.")
    finish(it, it.high.name, it.high.amount, "live")
    return "won"
end

function A.End()
    if not A.session then return end
    A.Flush()
    A.session.ended = true
    -- Test awards come back off: they were only practice.
    if A.session.test then
        local kept = {}
        for _, r in ipairs(D.db.results) do if not r.test then kept[#kept + 1] = r end end
        D.db.results = kept
    end
    if not A.session.solo then M.Send("X:" .. A.session.sid, C.GroupChannel()) end
    if ns.B then ns.B.Close(A.session.sid) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end
