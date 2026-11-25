-- Mystic Dragons Bids: windows. Plain game frames, no libraries.
--   Loot master window: every item up for bids, its bids, Last call / Award / Roll it off / Give…
--   Bid window: every item, a box for your bid, Bid and Pass.
--   Text window: for pasting the sheet in and copying results out.
local _, ns = ...
local C, D, A, B = ns.C, ns.D, ns.A, ns.B
local UI = {}
ns.UI = UI

local GOLD, GREEN, RED, GREY = "|cffCDB07C", "|cff7CD67C", "|cffD96A5F", "|cff8F857C"
local ROWS = 10

local function backdrop(f)
    if f.SetBackdrop then
        f:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 1 })
        f:SetBackdropColor(0.07, 0.06, 0.06, 0.95)
        f:SetBackdropBorderColor(0.80, 0.69, 0.49, 0.8)
    end
end

local function window(name, title, w, h)
    local f = CreateFrame("Frame", name, UIParent, "BackdropTemplate")
    f:SetSize(w, h); f:SetPoint("CENTER"); f:SetFrameStrata("DIALOG"); f:SetClampedToScreen(true)
    f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton")
    f:SetScript("OnDragStart", f.StartMoving)
    f:SetScript("OnDragStop", function(self)
        self:StopMovingOrSizing()
        local p, _, rp, x, y = self:GetPoint()
        if D.db then D.db.opts.pos = D.db.opts.pos or {}; D.db.opts.pos[name] = { p, rp, x, y } end
    end)
    f.place = function(self, dx, dy)
        local pos = D.db and D.db.opts.pos and D.db.opts.pos[name]
        self:ClearAllPoints()
        if pos then self:SetPoint(pos[1], UIParent, pos[2], pos[3], pos[4]) else self:SetPoint("CENTER", UIParent, "CENTER", dx or 0, dy or 0) end
    end
    backdrop(f)
    f.title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    f.title:SetPoint("TOPLEFT", 14, -12); f.title:SetText(title)
    local x = CreateFrame("Button", nil, f, "UIPanelCloseButton"); x:SetPoint("TOPRIGHT", 2, 2)
    f.sub = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    f.sub:SetPoint("TOPLEFT", 14, -34); f.sub:SetJustifyH("LEFT"); f.sub:SetWidth(w - 28)
    tinsert(UISpecialFrames, name)
    f:Hide()
    return f
end

local function button(parent, text, w, onClick)
    local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
    b:SetSize(w, 22); b:SetText(text)
    -- Every click also sends waiting whisper replies (Forever only lets chat out on a click).
    b:SetScript("OnClick", function(self, ...) if A.Flush then A.Flush() end; onClick(self, ...) end)
    return b
end

local function itemIcon(parent)
    local b = CreateFrame("Button", nil, parent)
    b:SetSize(28, 28)
    b.tex = b:CreateTexture(nil, "ARTWORK"); b.tex:SetAllPoints()
    b:SetScript("OnEnter", function(self)
        if not self.link and not self.itemId then return end
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        if self.link then GameTooltip:SetHyperlink(self.link) else GameTooltip:SetItemByID(self.itemId) end
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function() GameTooltip:Hide() end)
    b:SetScript("OnClick", function(self) if self.link and IsModifiedClick("CHATLINK") then ChatEdit_InsertLink(self.link) end end)
    return b
end

local function fillItem(row, it)
    local name, link, _, icon = C.ItemInfo(it.link or it.itemId)
    if not link and it.itemId and C_Item and C_Item.RequestLoadItemDataByID then C_Item.RequestLoadItemDataByID(it.itemId) end
    it.link, it.name = it.link or link, it.name or name
    row.icon.link, row.icon.itemId = it.link, it.itemId
    row.icon.tex:SetTexture(icon or C.ItemIcon(it.itemId) or "Interface\\Icons\\INV_Misc_QuestionMark")
    row.name:SetText(it.link or it.name or ("Item " .. tostring(it.itemId)))
end

local function countdown(it)
    if not it.lcEnd then return "" end
    local left = it.lcEnd - C.Now()
    if left > 0 then return GOLD .. "Last call: " .. left .. "s|r" end
    return RED .. "Time's up|r"
end

------------------------------------------------------------------------
-- Loot master window
------------------------------------------------------------------------
local lm
local function buildLM()
    lm = window("MDBidsLMFrame", GOLD .. "Mystic Dragons|r loot master", 640, 120 + ROWS * 46)
    lm.rows = {}
    for i = 1, ROWS do
        local r = CreateFrame("Frame", nil, lm)
        r:SetSize(612, 42); r:SetPoint("TOPLEFT", 14, -56 - (i - 1) * 46)
        r.icon = itemIcon(r); r.icon:SetPoint("LEFT", 0, 0)
        r.name = r:CreateFontString(nil, "OVERLAY", "GameFontHighlight"); r.name:SetPoint("TOPLEFT", r.icon, "TOPRIGHT", 8, 0); r.name:SetWidth(240); r.name:SetJustifyH("LEFT")
        r.bids = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); r.bids:SetPoint("TOPLEFT", r.name, "BOTTOMLEFT", 0, -2); r.bids:SetWidth(300); r.bids:SetJustifyH("LEFT")
        r.clock = r:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); r.clock:SetPoint("TOPRIGHT", r, "TOPRIGHT", -250, 0)
        r.live = button(r, "Live auction", 96, function() local it = A.session.items[r.idx]; if it.state == "later" then A.StartLive(r.idx) else A.SaveForLive(r.idx) end end); r.live:SetPoint("RIGHT", 0, 0)
        r.award = button(r, "Award", 84, function() A.Award(r.idx) end); r.award:SetPoint("RIGHT", r.live, "LEFT", -4, 0)
        r.last = button(r, "Last call", 76, function() A.LastCall(r.idx) end); r.last:SetPoint("RIGHT", r.award, "LEFT", -4, 0)
        -- Roll-off winner: type the name (or target them), then Give.
        r.who = CreateFrame("EditBox", nil, r, "InputBoxTemplate"); r.who:SetSize(130, 22); r.who:SetAutoFocus(false); r.who:SetPoint("RIGHT", -70, 0)
        r.whoGo = button(r, "Give", 60, function()
            local ok, why = A.ManualAward(r.idx, r.who:GetText(), 0, "roll")
            if not ok then ns.Print(why) else r.who:SetText("") end
        end); r.whoGo:SetPoint("RIGHT", 0, 0)
        r.who:SetScript("OnEditFocusGained", function(self) if self:GetText() == "" and UnitExists("target") and UnitIsPlayer("target") then self:SetText(C.Norm(GetUnitName("target", true)) or "") end end)
        r.undo = button(r, "Undo", 60, function() A.Undo(r.idx) end); r.undo:SetPoint("RIGHT", 0, 0)
        r:Hide()
        lm.rows[i] = r
    end
    lm.replies = lm:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); lm.replies:SetPoint("BOTTOMLEFT", 16, 46)
    lm.send = button(lm, "Send replies", 110, function() UI.Refresh() end); lm.send:SetPoint("BOTTOMLEFT", 14, 14)
    lm.endb = button(lm, "End bidding", 110, function() A.End() end); lm.endb:SetPoint("BOTTOMRIGHT", -14, 14)
    lm.hist = button(lm, "History", 80, function() UI.ShowHistory() end); lm.hist:SetPoint("RIGHT", lm.endb, "LEFT", -6, 0)
    lm.bals = button(lm, "Balances", 80, function() UI.ShowBalances() end); lm.bals:SetPoint("RIGHT", lm.hist, "LEFT", -6, 0)
    lm.note = lm:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); lm.note:SetPoint("BOTTOM", 0, 18)
    lm.note:SetText("Live auction sets an item aside. When the rest is done, press it again to run that auction.")
    local t = 0
    lm:SetScript("OnUpdate", function(_, e) t = t + e; if t > 0.5 then t = 0; UI.Refresh() end end)
end

function UI.ShowLM() if not lm then buildLM() end; if not lm:IsShown() then lm:place(-340, 40) end; lm:Show(); UI.Refresh() end

local function drawLM()
    if not (lm and lm:IsShown()) then return end
    local s = A.session
    lm.sub:SetText(s and ((s.test and (RED .. "TEST — nothing is real. |r") or "") .. (s.ended and "Bidding is over." or "Bidding is open. You can't see an item's bids until you've bid or passed on it.")) or "No bidding open.")
    for i, r in ipairs(lm.rows) do
        local it = s and s.items[i]
        if not it then r:Hide() else
            r:Show(); r.idx = i; fillItem(r, it)
            local ranked = A.Ranked(i)
            local passes = 0; for _ in pairs(it.passes) do passes = passes + 1 end
            local text
            if it.state == "done" then text = GREEN .. (it.winner == "-" and "Nobody" or it.winner) .. " — " .. (it.price or 0) .. " DKP|r"
            elseif it.state == "roll" then text = GOLD .. "Roll it off, then type the winner and Give.|r"
            elseif it.state == "later" then text = GOLD .. "Saved for a live auction. Press Live auction when the rest is done.|r"
            elseif it.state == "live" then text = GOLD .. "Live auction running: " .. (it.high and (it.high.name .. " " .. it.high.amount) or "no bids yet") .. "|r"
            elseif not it.lmDecided then text = GREY .. #ranked .. " bid" .. (#ranked == 1 and "" or "s") .. ", " .. passes .. " pass" .. (passes == 1 and "" or "es") .. ". Bid or pass in your bid window to see them.|r"
            else
                local parts = {}
                for n = 1, math.min(4, #ranked) do parts[#parts + 1] = ranked[n].name .. " " .. ranked[n].amount end
                text = (#ranked == 0 and (GREY .. "No bids yet") or table.concat(parts, ", ")) .. GREY .. (#ranked > 4 and (" +" .. (#ranked - 4)) or "") .. " · " .. passes .. " passed|r"
                if it.state == "tie" then text = GOLD .. "Tie at " .. it.tieAt .. ", waiting on rebids. |r" .. text end
            end
            r.bids:SetText(text)
            r.clock:SetText(it.state ~= "done" and countdown(it) or "")
            local live = not s.ended
            local bidding = live and (it.state == "open" or it.state == "tie")
            r.last:SetShown(bidding); r.award:SetShown(bidding)
            r.award:SetText(#ranked == 0 and it.state ~= "tie" and "Roll it off" or "Award")
            r.live:SetShown(live and (bidding or it.state == "later" or it.state == "live"))
            r.live:SetText(it.state == "later" and "Start live" or it.state == "live" and "Open live" or "Live auction")
            if it.state == "live" then r.live:SetScript("OnClick", function() A.Flush(); UI.ShowLive(i) end)
            else r.live:SetScript("OnClick", function() A.Flush(); if it.state == "later" then A.StartLive(i) else A.SaveForLive(i) end end) end
            r.who:SetShown(live and it.state == "roll"); r.whoGo:SetShown(live and it.state == "roll")
            r.undo:SetShown(it.state == "done" and it.winner ~= "-")
        end
    end
    local n = #A.replies
    lm.replies:SetText(n > 0 and (GOLD .. n .. " whisper repl" .. (n == 1 and "y" or "ies") .. " waiting. Any click sends them.|r") or "")
    lm.send:SetShown(n > 0)
    lm.endb:SetText(s and s.ended and "Close" or "End bidding")
    lm.endb:SetScript("OnClick", function() A.Flush(); if s and not s.ended then A.End() else lm:Hide() end end)
end

------------------------------------------------------------------------
-- Live auction window: one item, everyone sees the high bid, each bid has to beat it.
------------------------------------------------------------------------
local lv
local GRID = 40
function UI.ShowLive(idx)
    if not lv then
        lv = window("MDBidsLiveFrame", GOLD .. "Live auction|r", 560, 470)
        lv.icon = itemIcon(lv); lv.icon:SetSize(40, 40); lv.icon:SetPoint("TOPLEFT", 14, -58)
        lv.name = lv:CreateFontString(nil, "OVERLAY", "GameFontHighlightLarge"); lv.name:SetPoint("LEFT", lv.icon, "RIGHT", 10, 0); lv.name:SetWidth(480); lv.name:SetJustifyH("LEFT")
        lv.high = lv:CreateFontString(nil, "OVERLAY", "GameFontNormalHuge"); lv.high:SetPoint("TOPLEFT", 14, -112)
        lv.list = lv:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); lv.list:SetPoint("TOPLEFT", 14, -146); lv.list:SetWidth(530); lv.list:SetJustifyH("LEFT")
        -- Bids heard in voice: type the amount, click the name.
        lv.lab = lv:CreateFontString(nil, "OVERLAY", "GameFontNormal"); lv.lab:SetPoint("TOPLEFT", 14, -172); lv.lab:SetText("Heard a bid in voice? Type it, then click their name:")
        lv.amount = CreateFrame("EditBox", nil, lv, "InputBoxTemplate"); lv.amount:SetSize(60, 22); lv.amount:SetPoint("LEFT", lv.lab, "RIGHT", 12, 0)
        lv.amount:SetAutoFocus(false); lv.amount:SetNumeric(true); lv.amount:SetMaxLetters(4)
        lv.err = lv:CreateFontString(nil, "OVERLAY", "GameFontRedSmall"); lv.err:SetPoint("TOPLEFT", 14, -196); lv.err:SetWidth(530); lv.err:SetJustifyH("LEFT")
        lv.grid = {}
        for i = 1, GRID do
            local b = CreateFrame("Button", nil, lv, "UIPanelButtonTemplate")
            b:SetSize(128, 20)
            b:SetPoint("TOPLEFT", 14 + ((i - 1) % 4) * 133, -214 - math.floor((i - 1) / 4) * 22)
            b:SetScript("OnClick", function(self)
                A.Flush()
                local amt = tonumber(lv.amount:GetText())
                if not amt then lv.err:SetText("Type the amount first."); return end
                local ok, why = A.Bid(self.who, A.session.sid, lv.idx, amt, "manual")
                if ok then lv.err:SetText(""); lv.amount:SetText("") else lv.err:SetText(why) end
            end)
            b:Hide(); lv.grid[i] = b
        end
        lv.going = button(lv, "Going once", 110, function() A.Going(lv.idx) end); lv.going:SetPoint("BOTTOMLEFT", 14, 14)
        lv.sold = button(lv, "Sold", 90, function()
            local r, why = A.Sold(lv.idx)
            if r == "won" or r == "roll" then lv:Hide() elseif why then lv.err:SetText(why) end
        end); lv.sold:SetPoint("BOTTOMRIGHT", -14, 14)
        lv.cancel = button(lv, "Back to the list", 120, function() lv:Hide() end); lv.cancel:SetPoint("BOTTOM", 0, 14)
    end
    lv.idx = idx; lv.err:SetText(""); lv.amount:SetText("")
    lv:place(0, 60); lv:Show(); UI.Refresh()
end

local function drawLive()
    if not (lv and lv:IsShown()) then return end
    local it = A.session and A.session.items[lv.idx]
    if not it or it.state ~= "live" then lv:Hide(); return end
    lv.sub:SetText("Run it in voice. Bids also come in from bid windows and whispers. Each one has to beat the high bid.")
    fillItem(lv, it)
    lv.high:SetText(it.high and (GOLD .. it.high.amount .. "|r  " .. it.high.name .. (it.high.voice and (GREY .. " (voice)|r") or "")) or (GREY .. "No bids yet|r"))
    local lines = {}
    for n = 2, math.min(7, #it.history) do lines[#lines + 1] = it.history[n].name .. " " .. it.history[n].amount end
    lv.list:SetText(#lines > 0 and (GREY .. "Earlier: " .. table.concat(lines, ", ") .. "|r") or "")
    lv.going:SetText((it.going or 0) == 0 and "Going once" or "Going twice")
    lv.going:SetEnabled((it.going or 0) < 2)
    local names = A.LiveBidders(lv.idx)
    for i, b in ipairs(lv.grid) do
        local n = names[i]
        if n then b.who = n; b:SetText(n); b:Show() else b:Hide() end
    end
end

------------------------------------------------------------------------
-- Bid window (everyone, the loot master too)
------------------------------------------------------------------------
local bw
local function buildBW()
    bw = window("MDBidsBidFrame", GOLD .. "Mystic Dragons|r bids", 520, 110 + ROWS * 46)
    bw.rows = {}
    for i = 1, ROWS do
        local r = CreateFrame("Frame", nil, bw)
        r:SetSize(492, 42); r:SetPoint("TOPLEFT", 14, -56 - (i - 1) * 46)
        r.icon = itemIcon(r); r.icon:SetPoint("LEFT", 0, 0)
        r.name = r:CreateFontString(nil, "OVERLAY", "GameFontHighlight"); r.name:SetPoint("TOPLEFT", r.icon, "TOPRIGHT", 8, 0); r.name:SetWidth(230); r.name:SetJustifyH("LEFT")
        r.status = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); r.status:SetPoint("TOPLEFT", r.name, "BOTTOMLEFT", 0, -2); r.status:SetWidth(230); r.status:SetJustifyH("LEFT")
        r.pass = button(r, "Pass", 54, function() B.Bid(r.idx, "pass") end); r.pass:SetPoint("RIGHT", 0, 0)
        -- A refused bid shows in red under the item for 8 seconds.
        local function try(text)
            local ok, why = B.Bid(r.idx, text)
            local it = B.cur and B.cur.items[r.idx]
            if it then if ok then it.err = nil else it.err, it.errUntil = why, C.Now() + 8 end end
            UI.Refresh()
        end
        r.bid = button(r, "Bid", 54, function() try(r.box:GetText()) end); r.bid:SetPoint("RIGHT", r.pass, "LEFT", -4, 0)
        r.box = CreateFrame("EditBox", nil, r, "InputBoxTemplate"); r.box:SetSize(50, 22); r.box:SetPoint("RIGHT", r.bid, "LEFT", -8, 0)
        r.box:SetAutoFocus(false); r.box:SetNumeric(true); r.box:SetMaxLetters(4)
        r.box:SetScript("OnEnterPressed", function(self) self:ClearFocus(); try(self:GetText()) end)
        r.clock = r:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); r.clock:SetPoint("RIGHT", r.box, "LEFT", -10, 0)
        r:Hide()
        bw.rows[i] = r
    end
    bw.foot = bw:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); bw.foot:SetPoint("BOTTOMLEFT", 16, 16); bw.foot:SetWidth(488); bw.foot:SetJustifyH("LEFT")
    bw.foot:SetText("No addon? Whisper the loot master the item link and your bid, or \"pass\". Minimum bid is 1.")
    local t = 0
    bw:SetScript("OnUpdate", function(_, e) t = t + e; if t > 0.5 then t = 0; UI.Refresh() end end)
end

function UI.ShowBidder() if not bw then buildBW() end; if not bw:IsShown() then bw:place(A.IsMine() and 300 or 0, 40) end; bw:Show(); UI.Refresh() end

local function drawBW()
    if not (bw and bw:IsShown()) then return end
    local cur = B.cur
    if not cur then bw:Hide(); return end
    local can, why = D.Spendable(C.PlayerName())
    bw.sub:SetText((cur.closed and "Bidding is over. " or ("Loot master: " .. cur.lm .. ". ")) .. (why and (RED .. why .. "|r") or ("You have " .. GOLD .. can .. "|r DKP to spend.")))
    for i, r in ipairs(bw.rows) do
        local it = cur.items[i]
        if not it then r:Hide() else
            r:Show(); r.idx = i; fillItem(r, it)
            local err = it.err and C.Now() < (it.errUntil or 0) and it.err
            r.status:SetText(err and (RED .. err .. "|r") or it.status or "")
            local open = not cur.closed and (it.state == "open" or it.state == "live" or (it.state == "tie" and it.canBid))
            r.box:SetShown(open); r.bid:SetShown(open); r.pass:SetShown(open and it.state == "open")
            r.clock:SetText(it.state ~= "done" and countdown(it) or "")
        end
    end
end

------------------------------------------------------------------------
-- Text window: paste the sheet in, copy results out
------------------------------------------------------------------------
local tw
function UI.ShowText(title, help, text, onOk)
    if not tw then
        tw = window("MDBidsTextFrame", "", 520, 300)
        local sf = CreateFrame("ScrollFrame", nil, tw, "UIPanelScrollFrameTemplate")
        sf:SetPoint("TOPLEFT", 14, -60); sf:SetPoint("BOTTOMRIGHT", -34, 48)
        tw.box = CreateFrame("EditBox", nil, sf); tw.box:SetMultiLine(true); tw.box:SetFontObject(ChatFontNormal); tw.box:SetWidth(460); tw.box:SetAutoFocus(true)
        tw.box:SetScript("OnEscapePressed", function() tw:Hide() end)
        sf:SetScrollChild(tw.box)
        tw.ok = button(tw, "OK", 100, function() if tw.onOk then tw.onOk(tw.box:GetText()) else tw:Hide() end end)
        tw.ok:SetPoint("BOTTOMRIGHT", -14, 14)
        tw.err = tw:CreateFontString(nil, "OVERLAY", "GameFontRedSmall"); tw.err:SetPoint("BOTTOMLEFT", 14, 18); tw.err:SetWidth(380); tw.err:SetJustifyH("LEFT")
    end
    tw.title:SetText(title); tw.sub:SetText(help); tw.err:SetText("")
    tw.onOk = onOk
    tw.ok:SetText(onOk and "Import" or "Done")
    tw.box:SetText(text or ""); tw:Show(); tw.box:SetFocus()
    if text and text ~= "" then tw.box:HighlightText() end
end
function UI.TextError(msg) if tw then tw.err:SetText(msg) end end
function UI.HideText() if tw then tw:Hide() end end

------------------------------------------------------------------------
-- List windows: DKP history and balances. Search box, clickable column headers, mouse-wheel scrolling.
------------------------------------------------------------------------
local LIST_ROWS = 16
local function listWindow(name, title, w, cols)
    local f = window(name, title, w, 150 + LIST_ROWS * 22)
    f.search = CreateFrame("EditBox", nil, f, "InputBoxTemplate"); f.search:SetSize(200, 22); f.search:SetPoint("TOPRIGHT", -40, -10); f.search:SetAutoFocus(false)
    f.search:SetScript("OnTextChanged", function() f.offset = 0; UI.Refresh() end)
    f.searchHint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); f.searchHint:SetPoint("RIGHT", f.search, "LEFT", -8, 0); f.searchHint:SetText("Search")
    f.cols, f.sortKey, f.sortDesc, f.offset = cols, cols.defaultSort, cols.defaultDesc, 0
    f.heads = {}
    local x = 14
    for i, c in ipairs(cols) do
        local h = CreateFrame("Button", nil, f)
        h:SetSize(c.w, 18); h:SetPoint("TOPLEFT", x, -58)
        h.text = h:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); h.text:SetAllPoints(); h.text:SetJustifyH(c.right and "RIGHT" or "LEFT")
        h:SetScript("OnClick", function()
            if not c.sort then return end
            if f.sortKey == c.sort then f.sortDesc = not f.sortDesc else f.sortKey, f.sortDesc = c.sort, c.desc or false end
            UI.Refresh()
        end)
        f.heads[i] = h; c.x = x; x = x + c.w + 8
    end
    f.rows = {}
    for r = 1, LIST_ROWS do
        local row = CreateFrame("Frame", nil, f); row:SetSize(w - 28, 20); row:SetPoint("TOPLEFT", 14, -80 - (r - 1) * 22)
        row.cells = {}
        for i, c in ipairs(cols) do
            if c.item then
                local ic = itemIcon(row); ic:SetSize(18, 18); ic:SetPoint("LEFT", c.x - 14, 0)
                local t = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); t:SetPoint("LEFT", ic, "RIGHT", 4, 0); t:SetWidth(c.w - 22); t:SetJustifyH("LEFT"); t:SetWordWrap(false)
                row.cells[i] = t; row.icon = ic
            else
                local t = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); t:SetPoint("LEFT", c.x - 14, 0); t:SetWidth(c.w); t:SetJustifyH(c.right and "RIGHT" or "LEFT"); t:SetWordWrap(false)
                row.cells[i] = t
            end
        end
        row:Hide(); f.rows[r] = row
    end
    f:EnableMouseWheel(true)
    f:SetScript("OnMouseWheel", function(_, d) f.offset = math.max(0, (f.offset or 0) - d * 3); UI.Refresh() end)
    f.foot = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); f.foot:SetPoint("BOTTOMLEFT", 16, 18); f.foot:SetWidth(w - 32); f.foot:SetJustifyH("LEFT")
    return f
end

local function drawList(f, items, cell)
    for i, c in ipairs(f.cols) do f.heads[i].text:SetText(c.title .. (f.sortKey == c.sort and (f.sortDesc and " v" or " ^") or "")) end
    local q = (f.search:GetText() or ""):lower()
    local shown = {}
    for _, it in ipairs(items) do if q == "" or (it._search or ""):find(q, 1, true) then shown[#shown + 1] = it end end
    local k, desc = f.sortKey, f.sortDesc
    table.sort(shown, function(a, b)
        local x, y = a[k], b[k]
        if x == y then return (a._tie or "") < (b._tie or "") end
        if type(x) ~= type(y) then x, y = tostring(x), tostring(y) end
        if desc then return x > y else return x < y end
    end)
    f.offset = math.min(f.offset or 0, math.max(0, #shown - LIST_ROWS))
    for r, row in ipairs(f.rows) do
        local it = shown[r + f.offset]
        if it then row:Show(); cell(row, it) else row:Hide() end
    end
    return shown
end

local KIND = { bid = "bid", live = "live auction", roll = "rolled off" }
local hw
function UI.ShowHistory()
    if not hw then
        hw = listWindow("MDBidsHistoryFrame", GOLD .. "DKP|r history", 760, {
            { title = "Date", w = 92, sort = "at", desc = true }, { title = "Item", w = 230, item = true, sort = "itemSort" },
            { title = "Winner", w = 130, sort = "winner" }, { title = "DKP", w = 40, right = true, sort = "price", desc = true },
            { title = "How", w = 80, sort = "kind" }, { title = "Loot master", w = 110, sort = "lm" },
            defaultSort = "at", defaultDesc = true })
    end
    hw:place(0, 40); hw:Show(); UI.Refresh()
end
local function drawHistory()
    if not (hw and hw:IsShown()) then return end
    local all, mine = D.CanSeeAll(), D.PersonOf(C.PlayerName())
    local items = {}
    for _, r in ipairs(D.AllAwards()) do
        if all or r.person == mine then
            local name = r.itemName or (r.itemId and C.ItemInfo(r.itemId)) or ("Item " .. tostring(r.itemId or "?"))
            r.itemSort = tostring(name):gsub("|c%x+|H.-|h%[?(.-)%]?|h|r", "%1"):lower()
            r._search = (r.itemSort .. " " .. tostring(r.winner) .. " " .. tostring(r.lm) .. " " .. (KIND[r.kind] or "")):lower()
            r._tie = tostring(r.lm) .. r.seq
            items[#items + 1] = r
        end
    end
    hw.sub:SetText(all and ("Every award this addon knows about, from every loot master with the addon (kept " .. (D.db.opts.keepDays or 120) .. " days). The site has the full ledger.")
        or "Your awards. Officers and loot masters see everyone's.")
    local shown = drawList(hw, items, function(row, r)
        local name, link, _, icon = C.ItemInfo(r.itemId or r.itemName)
        if not link and r.itemId and C_Item and C_Item.RequestLoadItemDataByID then C_Item.RequestLoadItemDataByID(r.itemId) end
        row.icon.link, row.icon.itemId = link, r.itemId
        row.icon.tex:SetTexture(icon or C.ItemIcon(r.itemId) or "Interface\\Icons\\INV_Misc_QuestionMark")
        local d = date("%b %d %H:%M", r.at or 0)
        local dim = r.undone and GREY or ""
        row.cells[1]:SetText(dim .. d)
        row.cells[2]:SetText(r.undone and (GREY .. (name or r.itemName or "?") .. " (undone)|r") or (link or r.itemName or name or "?"))
        row.cells[3]:SetText(dim .. tostring(r.winner))
        row.cells[4]:SetText(dim .. tostring(r.price or 0))
        row.cells[5]:SetText(GREY .. (KIND[r.kind] or r.kind or "") .. "|r")
        row.cells[6]:SetText(GREY .. tostring(r.lm) .. "|r")
    end)
    local total = 0; for _, r in ipairs(shown) do if not r.undone then total = total + (r.price or 0) end end
    hw.foot:SetText(#shown .. " award" .. (#shown == 1 and "" or "s") .. ", " .. total .. " DKP. Scroll with the mouse wheel. Click a column to sort.")
end

local bal
function UI.ShowBalances()
    if not bal then
        bal = listWindow("MDBidsBalanceFrame", GOLD .. "DKP|r balances", 560, {
            { title = "Name", w = 200, sort = "name" }, { title = "On the sheet", w = 80, right = true, sort = "sheet", desc = true },
            { title = "Spent since", w = 80, right = true, sort = "spent", desc = true }, { title = "Can spend", w = 80, right = true, sort = "can", desc = true },
            defaultSort = "can", defaultDesc = true })
    end
    bal:place(0, 40); bal:Show(); UI.Refresh()
end
local function drawBalances()
    if not (bal and bal:IsShown()) then return end
    local s = D.db.sheet
    if not s then bal.sub:SetText(RED .. "No sheet loaded yet.|r"); for _, r in ipairs(bal.rows) do r:Hide() end; bal.foot:SetText(""); return end
    local all, mine = D.IsOfficer(), D.PersonOf(C.PlayerName())   -- everyone's balances: officers and the GM only
    local items = {}
    for person, n in pairs(s.bal) do
        if all or person == mine then
            local can = D.Spendable(s.display[person] or person)
            local alts = s.alts[person] or {}
            items[#items + 1] = { name = s.display[person] or person, alts = alts, sheet = n, spent = n - can, can = can,
                                  _search = ((s.display[person] or person) .. " " .. table.concat(alts, " ")):lower(), _tie = person }
        end
    end
    bal.sub:SetText("Sheet approved " .. ns.When(s.at) .. (s.by ~= "" and (" by " .. s.by) or "") .. ". Can spend = the sheet minus awards since it was approved." .. (all and "" or " Officers see everyone's."))
    local shown = drawList(bal, items, function(row, it)
        row.cells[1]:SetText(it.name .. (#it.alts > 0 and (GREY .. "  " .. table.concat(it.alts, ", ") .. "|r") or ""))
        row.cells[2]:SetText(tostring(it.sheet))
        row.cells[3]:SetText(it.spent > 0 and ("-" .. it.spent) or (GREY .. "0|r"))
        row.cells[4]:SetText(GOLD .. it.can .. "|r")
    end)
    bal.foot:SetText(#shown .. " " .. (#shown == 1 and "person" or "people") .. ". Scroll with the mouse wheel. Click a column to sort.")
end

function UI.Refresh() drawLM(); drawBW(); drawLive(); drawHistory(); drawBalances() end
