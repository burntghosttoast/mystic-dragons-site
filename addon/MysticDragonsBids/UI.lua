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
    f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
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
        r.give = button(r, "Give…", 60, function() UI.ShowGive(r.idx) end); r.give:SetPoint("RIGHT", 0, 0)
        r.award = button(r, "Award", 80, function() A.Award(r.idx) end); r.award:SetPoint("RIGHT", r.give, "LEFT", -4, 0)
        r.last = button(r, "Last call", 80, function() A.LastCall(r.idx) end); r.last:SetPoint("RIGHT", r.award, "LEFT", -4, 0)
        r:Hide()
        lm.rows[i] = r
    end
    lm.replies = lm:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); lm.replies:SetPoint("BOTTOMLEFT", 16, 46)
    lm.send = button(lm, "Send replies", 110, function() UI.Refresh() end); lm.send:SetPoint("BOTTOMLEFT", 14, 14)
    lm.endb = button(lm, "End bidding", 110, function() A.End() end); lm.endb:SetPoint("BOTTOMRIGHT", -14, 14)
    lm.note = lm:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); lm.note:SetPoint("BOTTOM", 0, 18)
    lm.note:SetText("Live auction? Run it in voice, then Give… with the price.")
    local t = 0
    lm:SetScript("OnUpdate", function(_, e) t = t + e; if t > 0.5 then t = 0; UI.Refresh() end end)
end

function UI.ShowLM() if not lm then buildLM() end; lm:Show(); UI.Refresh() end

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
            elseif it.state == "roll" then text = GOLD .. "No bids. Roll it off, then Give… to the winner.|r"
            elseif not it.lmDecided then text = GREY .. #ranked .. " bid" .. (#ranked == 1 and "" or "s") .. ", " .. passes .. " pass" .. (passes == 1 and "" or "es") .. ". Bid or pass in your bid window to see them.|r"
            else
                local parts = {}
                for n = 1, math.min(4, #ranked) do parts[#parts + 1] = ranked[n].name .. " " .. ranked[n].amount end
                text = (#ranked == 0 and (GREY .. "No bids yet") or table.concat(parts, ", ")) .. GREY .. (#ranked > 4 and (" +" .. (#ranked - 4)) or "") .. " · " .. passes .. " passed|r"
                if it.state == "tie" then text = GOLD .. "Tie at " .. it.tieAt .. ", waiting on rebids. |r" .. text end
            end
            r.bids:SetText(text)
            r.clock:SetText(it.state ~= "done" and countdown(it) or "")
            local open = it.state ~= "done" and not (s.ended)
            r.last:SetShown(open and it.state ~= "roll"); r.award:SetShown(open and it.state ~= "roll")
            r.award:SetText(#ranked == 0 and "Roll it off" or "Award")
            r.give:SetText(it.state == "done" and "Undo" or "Give…")
            r.give:SetScript("OnClick", function() A.Flush(); if it.state == "done" then A.Undo(i) else UI.ShowGive(i) end end)
        end
    end
    local n = #A.replies
    lm.replies:SetText(n > 0 and (GOLD .. n .. " whisper repl" .. (n == 1 and "y" or "ies") .. " waiting. Any click sends them.|r") or "")
    lm.send:SetShown(n > 0)
    lm.endb:SetText(s and s.ended and "Close" or "End bidding")
    lm.endb:SetScript("OnClick", function() A.Flush(); if s and not s.ended then A.End() else lm:Hide() end end)
end

------------------------------------------------------------------------
-- Give… (manual award: live auction, roll-off winner, or a fix)
------------------------------------------------------------------------
local give
function UI.ShowGive(idx)
    local it = A.session and A.session.items[idx]; if not it then return end
    if not give then
        give = window("MDBidsGiveFrame", "Give item", 320, 170)
        give.nameBox = CreateFrame("EditBox", nil, give, "InputBoxTemplate"); give.nameBox:SetSize(180, 22); give.nameBox:SetPoint("TOPLEFT", 90, -60); give.nameBox:SetAutoFocus(false)
        give.priceBox = CreateFrame("EditBox", nil, give, "InputBoxTemplate"); give.priceBox:SetSize(60, 22); give.priceBox:SetPoint("TOPLEFT", 90, -90); give.priceBox:SetAutoFocus(false); give.priceBox:SetNumeric(true)
        local l1 = give:CreateFontString(nil, "OVERLAY", "GameFontNormal"); l1:SetPoint("RIGHT", give.nameBox, "LEFT", -10, 0); l1:SetText("Who")
        local l2 = give:CreateFontString(nil, "OVERLAY", "GameFontNormal"); l2:SetPoint("RIGHT", give.priceBox, "LEFT", -10, 0); l2:SetText("DKP")
        give.err = give:CreateFontString(nil, "OVERLAY", "GameFontRedSmall"); give.err:SetPoint("BOTTOMLEFT", 14, 44); give.err:SetWidth(290); give.err:SetJustifyH("LEFT")
        give.ok = button(give, "Give it", 100, function()
            local ok, why = A.ManualAward(give.idx, give.nameBox:GetText(), give.priceBox:GetText())
            if ok then give:Hide() else give.err:SetText(why) end
        end)
        give.ok:SetPoint("BOTTOMRIGHT", -14, 14)
    end
    give.idx = idx
    give.sub:SetText(it.link or it.name or "")
    give.nameBox:SetText(UnitExists("target") and UnitIsPlayer("target") and (C.Norm(GetUnitName("target", true)) or "") or "")
    give.priceBox:SetText("0"); give.err:SetText("")
    give:Show()
end

------------------------------------------------------------------------
-- Bid window (everyone, the loot master too)
------------------------------------------------------------------------
local bw
local function buildBW()
    bw = window("MDBidsBidFrame", GOLD .. "Mystic Dragons|r bids", 520, 110 + ROWS * 46)
    bw:SetPoint("CENTER", 0, 80)
    bw.rows = {}
    for i = 1, ROWS do
        local r = CreateFrame("Frame", nil, bw)
        r:SetSize(492, 42); r:SetPoint("TOPLEFT", 14, -56 - (i - 1) * 46)
        r.icon = itemIcon(r); r.icon:SetPoint("LEFT", 0, 0)
        r.name = r:CreateFontString(nil, "OVERLAY", "GameFontHighlight"); r.name:SetPoint("TOPLEFT", r.icon, "TOPRIGHT", 8, 0); r.name:SetWidth(230); r.name:SetJustifyH("LEFT")
        r.status = r:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall"); r.status:SetPoint("TOPLEFT", r.name, "BOTTOMLEFT", 0, -2); r.status:SetWidth(230); r.status:SetJustifyH("LEFT")
        r.pass = button(r, "Pass", 54, function() B.Bid(r.idx, "pass") end); r.pass:SetPoint("RIGHT", 0, 0)
        r.bid = button(r, "Bid", 54, function() local ok, why = B.Bid(r.idx, r.box:GetText()); if not ok then r.err = why; UI.Refresh() end end); r.bid:SetPoint("RIGHT", r.pass, "LEFT", -4, 0)
        r.box = CreateFrame("EditBox", nil, r, "InputBoxTemplate"); r.box:SetSize(50, 22); r.box:SetPoint("RIGHT", r.bid, "LEFT", -8, 0)
        r.box:SetAutoFocus(false); r.box:SetNumeric(true); r.box:SetMaxLetters(4)
        r.box:SetScript("OnEnterPressed", function(self) self:ClearFocus(); local ok, why = B.Bid(r.idx, self:GetText()); if not ok then r.err = why; UI.Refresh() end end)
        r.clock = r:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall"); r.clock:SetPoint("RIGHT", r.box, "LEFT", -10, 0)
        r:Hide()
        bw.rows[i] = r
    end
    bw.foot = bw:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall"); bw.foot:SetPoint("BOTTOMLEFT", 16, 16); bw.foot:SetWidth(488); bw.foot:SetJustifyH("LEFT")
    bw.foot:SetText("No addon? Whisper the loot master the item link and your bid, or \"pass\". Minimum bid is 1.")
    local t = 0
    bw:SetScript("OnUpdate", function(_, e) t = t + e; if t > 0.5 then t = 0; UI.Refresh() end end)
end

function UI.ShowBidder() if not bw then buildBW() end; bw:Show(); UI.Refresh() end

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
            r.status:SetText(r.err and (RED .. r.err .. "|r") or it.status or "")
            r.err = nil
            local open = not cur.closed and it.state ~= "done" and (it.state ~= "tie" or it.canBid or C.Key(cur.lm) == C.Key(C.PlayerName()))
            r.box:SetShown(open); r.bid:SetShown(open); r.pass:SetShown(open and it.state ~= "tie")
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

function UI.Refresh() drawLM(); drawBW() end
