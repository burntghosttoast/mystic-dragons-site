-- Mystic Dragons Bids: the raider's side. Shows the popup when the loot master opens bidding,
-- sends bids and passes, and shows what happened to each item.
local _, ns = ...
local C, D, M = ns.C, ns.D, ns.M
local B = {}
ns.B = B

B.cur = nil -- { lm, sid, items = { [idx] = { itemId, link, name, state, mine, status, lcEnd, tiedNames } } }

local function iAmLM() return B.cur and C.Key(B.cur.lm) == C.Key(C.PlayerName()) end

function B.Open(lm, sid, items, isLocal)
    local list = {}
    for idx, it in pairs(items) do
        list[idx] = { idx = idx, itemId = it.itemId, link = it.link, name = it.name, state = "open", status = "" }
    end
    B.cur = { lm = lm, sid = sid, items = list }
    if ns.UI then ns.UI.ShowBidder() end
end

function B.Close(sid)
    if B.cur and (not sid or B.cur.sid == sid) then B.cur.closed = true end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

local function me() return C.PlayerName() end
local function isMe(name)
    local p1, p2 = D.PersonOf(name), D.PersonOf(me())
    return p1 and p1 == p2
end

-- amount: a number or "pass"
function B.Bid(idx, amount)
    local cur = B.cur
    if not cur or cur.closed then return false, "Bidding is over." end
    local it = cur.items[idx]
    if not it then return false, "That item isn't up for bids." end
    if it.state == "later" then return false, "This one is saved for a live auction later." end
    if it.state == "live" and amount == "pass" then return false, "Just don't bid if you don't want it." end
    if amount ~= "pass" then
        amount = tonumber(amount)
        if it.state == "live" and amount and amount <= (it.high or 0) then return false, "Bid more than " .. (it.high or 0) .. "." end
        if not amount or amount < 1 or amount ~= math.floor(amount) then return false, "Bid a whole number, 1 or more." end
        local can, why = D.Spendable(me())
        if why then return false, why end
        if amount > can then return false, "You only have " .. can .. " DKP to spend." end
    end
    if iAmLM() then
        local ok, why = ns.A.Bid(me(), cur.sid, idx, amount, "self")
        if ok then it.mine = amount; it.status = amount == "pass" and "Passed" or ("Your bid: " .. amount) else it.status = why end
        if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
        return ok, why
    end
    it.mine = amount
    it.status = "Sending…"
    if amount == "pass" then M.Send("P:" .. cur.sid .. ":" .. idx, "WHISPER", cur.lm)
    else M.Send("B:" .. cur.sid .. ":" .. idx .. ":" .. amount, "WHISPER", cur.lm) end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
    return true
end

function B.Won(idx, winner, price)
    local it = B.cur and B.cur.items[idx]
    if not it then return end
    it.state = "done"
    if winner == "-" then it.status = "Rolled off"
    elseif isMe(winner) then it.status = "|cff7CD67CYou won it for " .. price .. "|r"
    else it.status = winner .. " won it for " .. price end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end

function B.OnMessage(sender, kind, msg)
    if kind == "O" then
        local sid, list = msg:match("^O:([^:]+):(.*)$")
        if not sid then return end
        if C.Key(sender) == C.Key(me()) and ns.A.IsMine() then return end -- my own session is already open locally
        local items = {}
        for idx, id in list:gmatch("(%d+)=(%d+)") do items[tonumber(idx)] = { itemId = tonumber(id) } end
        B.Open(sender, sid, items)
        return
    end
    local cur = B.cur
    if not cur or C.Key(sender) ~= C.Key(cur.lm) then return end
    if kind == "OK" or kind == "NO" then
        local sid, idx, rest = msg:match("^%u+:([^:]+):(%d+):(.*)$")
        local it = sid == cur.sid and cur.items[tonumber(idx)]
        if not it then return end
        if kind == "OK" then it.status = rest == "pass" and "Passed" or ("Your bid: " .. rest)
        else it.mine = nil; it.status = "|cffD96A5F" .. rest .. "|r" end
    elseif kind == "LC" then
        local sid, idx, sec = msg:match("^LC:([^:]+):(%d+):(%d+)$")
        local it = sid == cur.sid and cur.items[tonumber(idx)]
        if it then it.lcEnd = C.Now() + (tonumber(sec) or 30) end
    elseif kind == "RB" then
        local sid, idx, names = msg:match("^RB:([^:]+):(%d+):(.*)$")
        local it = sid == cur.sid and cur.items[tonumber(idx)]
        if not it then return end
        it.state, it.mine, it.lcEnd = "tie", nil, nil
        local mine = false
        for n in names:gmatch("[^/]+") do if isMe(n) then mine = true end end
        it.status = mine and "|cffCDB07CTie! Rebid now.|r" or ("Tie: " .. names:gsub("/", " vs "))
        it.canBid = mine
    elseif kind == "LL" or kind == "LV" or kind == "LH" then
        local sid, idx, amount, name = msg:match("^%u+:([^:]+):(%d+):?(%d*):?(.*)$")
        local it = sid == cur.sid and cur.items[tonumber(idx)]
        if not it then return end
        if kind == "LL" then it.state, it.status, it.mine = "later", "Live auction after the rest of the loot", nil
        elseif kind == "LV" then it.state, it.status, it.high, it.lcEnd = "live", "|cffCDB07CLive auction now! Bid more than the high bid.|r", 0, nil
        else
            it.high = tonumber(amount) or 0
            it.status = (isMe(name) and "|cff7CD67CYou're the high bid|r" or ("High bid: " .. name)) .. " at " .. it.high
        end
    elseif kind == "W" then
        local sid, idx, winner, price = msg:match("^W:([^:]+):(%d+):([^:]*):(%d+)$")
        if sid == cur.sid then B.Won(tonumber(idx), winner, tonumber(price)) end
        return
    elseif kind == "X" then
        local sid = msg:match("^X:(.*)$")
        B.Close(sid)
        return
    end
    if ns.UI and ns.UI.Refresh then ns.UI.Refresh() end
end
