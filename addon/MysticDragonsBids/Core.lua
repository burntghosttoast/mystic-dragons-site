-- Mystic Dragons Bids: start-up, game events, slash commands.
--   /mdkp              your DKP and what's open
--   /mdkp import       paste the approved sheet from the site (officers)
--   /mdkp export       copy tonight's results for the site (loot masters)
--   /mdkp test         practice alone with fake items and fake bidders
--   /mdkp test group   practice with your group: everyone gets the bid window, nothing is real
--   /mdkp show         reopen the windows
--   /mdkp history      every award (officers and loot masters), or your own
--   /mdkp balances     what everyone can spend (officers and the GM), or just you
--   /mdkp check        what works on this patch (send this to whoever maintains the addon)
--   /mdkp clear        forget results the site already has
--   /mdkp keep <days>  how long to keep old results on this PC (default 120, about a raid tier)
local addonName, ns = ...
local C, D, M, A, B, UI = ns.C, ns.D, ns.M, ns.A, ns.B, ns.UI

function ns.Print(msg) print("|cffCDB07CMD Bids|r " .. tostring(msg)) end
function ns.When(iso)
    local m, d, hh, mm = tostring(iso):match("^%d+%-(%d+)%-(%d+)T(%d+):(%d+)")
    if not m then return tostring(iso) end
    local months = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }
    return (months[tonumber(m)] or m) .. " " .. tonumber(d) .. ", " .. hh .. ":" .. mm .. " UTC"
end

-- Show a held whisper in chat the way the game would have.
function ns.EchoWhisper(sender, text)
    local frame = DEFAULT_CHAT_FRAME
    local info = ChatTypeInfo and ChatTypeInfo["WHISPER"]
    local line = "[" .. tostring(sender) .. "] whispers: " .. tostring(text)
    if frame then frame:AddMessage(line, info and info.r or 1, info and info.g or 0.5, info and info.b or 1) end
end

-- Whispers: a bid to the loot master is handled once (on the event) and the chat filter just reads
-- the answer by line id, because the filter runs once per chat window.
local hold = {}
local function filter(_, _, msg, sender, ...)
    local lineID = select(9, ...)
    return lineID and hold[lineID] or false
end

local TEST_ITEMS = { 18713, 17193, 18608, 19169, 18821, 19147, 18609, 18876, 19168, 21134 }
local FAKE = { "Test Bidder", "Pretend Raider", "Fake Mage" }

local function startTest(group)
    local items, used = {}, {}
    while #items < 4 do
        local id = TEST_ITEMS[math.random(#TEST_ITEMS)]
        if not used[id] then used[id] = true; items[#items + 1] = { itemId = id }; if C_Item and C_Item.RequestLoadItemDataByID then C_Item.RequestLoadItemDataByID(id) end end
    end
    if group and not C.InGroup() then ns.Print("You aren't in a group. Doing a solo test instead."); group = false end
    local ok, why = A.Start(items, { test = true, solo = not group })
    if not ok then ns.Print(why); return end
    if not group then
        -- Fake bidders bid over the next few seconds. Two of them tie on the first item, so you can see a rebid.
        for n, name in ipairs(FAKE) do
            C.After(1 + n, function()
                if not A.session or A.session.ended then return end
                for idx = 1, #A.session.items do
                    if math.random() < 0.7 then A.Bid(name, A.session.sid, idx, idx == 1 and n <= 2 and 25 or math.random(1, 40), "test")
                    else A.Bid(name, A.session.sid, idx, "pass", "test") end
                end
            end)
        end
        ns.Print("Practice started: 4 fake items, 3 fake bidders. Bid or pass in the bid window, then try Last call and Award. End bidding throws it all away.")
    else
        ns.Print("Group practice started. Everyone with the addon gets the bid window. Nothing is real, and End bidding throws it all away.")
    end
end

local function status()
    local s = D.db.sheet
    if not s then ns.Print("No DKP sheet yet. An officer imports it with /mdkp import, and it spreads to everyone with the addon.") return end
    local can, why = D.Spendable(C.PlayerName())
    ns.Print("Sheet approved " .. ns.When(s.at) .. (s.by ~= "" and (" by " .. s.by) or "") .. ".")
    ns.Print(why or ("You have " .. can .. " DKP to spend."))
end

SLASH_MDBIDS1, SLASH_MDBIDS2 = "/mdkp", "/mdbids"
SlashCmdList.MDBIDS = function(input)
    local cmd, rest = (input or ""):match("^%s*(%S*)%s*(.-)%s*$")
    cmd = cmd:lower()
    if cmd == "" then status()
    elseif cmd == "import" then
        UI.ShowText("Import DKP sheet", "On the site: Officer tools → DKP → Copy for the addon. Paste it here (Ctrl+V).", "", function(text)
            local sheet, why = D.ParseSheet(text)
            if not sheet then UI.TextError(why) return end
            D.SetSheet(sheet, true)
            UI.HideText()
            local n = 0; for _ in pairs(sheet.bal) do n = n + 1 end
            ns.Print("Imported the sheet approved " .. ns.When(sheet.at) .. ": " .. n .. " people. Sending it to everyone online with the addon.")
            M.SendSheet()
            UI.Refresh()
        end)
    elseif cmd == "export" then
        local text, n = D.ExportString()
        if n == 0 then ns.Print("No results to export yet.") return end
        UI.ShowText("Export results", n .. " result" .. (n == 1 and "" or "s") .. ". Ctrl+C, then paste on the site: Officer tools → DKP → Paste from the addon.", text)
    elseif cmd == "test" then startTest(rest:lower() == "group")
    elseif cmd == "show" then
        if A.session then UI.ShowLM() end
        if B.cur then UI.ShowBidder() end
        if not A.session and not B.cur then ns.Print("Nothing is open.") end
    elseif cmd == "history" or cmd == "h" then UI.ShowHistory()
    elseif cmd == "balances" or cmd == "bal" or cmd == "b" then UI.ShowBalances()
    elseif cmd == "check" then
        ns.Print("Version " .. C.VERSION .. ", game " .. tostring((select(4, GetBuildInfo()))) .. ":")
        for _, row in ipairs(C.Check()) do ns.Print(row[1] .. ": " .. (row[2] and "|cff7CD67Cworks|r" or "|cffD96A5FMISSING|r")) end
        local e = D.db.errors[1]
        if e then ns.Print("Last error: " .. e.msg) end
    elseif cmd == "clear" then ns.Print("Cleared " .. D.ClearResults() .. " old result(s).")
    elseif cmd == "keep" then
        local days = tonumber(rest)
        if days and days >= 14 and days <= 730 then
            D.db.opts.keepDays = math.floor(days)
            ns.Print("Keeping " .. D.db.opts.keepDays .. " days of results. Older ones drop off when the next sheet arrives.")
        elseif rest ~= "" then ns.Print("Pick a number of days between 14 and 730, like /mdkp keep 120.")
        else ns.Print("Keeping " .. (D.db.opts.keepDays or 120) .. " days of results (" .. #D.db.results .. " saved now). Change it with /mdkp keep <days>.") end
    else ns.Print("Commands: /mdkp, /mdkp import, /mdkp export, /mdkp test, /mdkp test group, /mdkp history, /mdkp balances, /mdkp show, /mdkp check, /mdkp clear, /mdkp keep") end
end

local f = CreateFrame("Frame")
f:RegisterEvent("ADDON_LOADED")
f:RegisterEvent("PLAYER_LOGIN")
f:RegisterEvent("CHAT_MSG_ADDON")
f:RegisterEvent("CHAT_MSG_WHISPER")
f:RegisterEvent("LOOT_READY")
f:RegisterEvent("GET_ITEM_INFO_RECEIVED")
f:SetScript("OnEvent", function(_, event, ...)
    local ok, err = pcall(function(...)
        if event == "ADDON_LOADED" and ... == addonName then
            D.Init(); C.RegisterPrefix()
            if ChatFrame_AddMessageEventFilter then ChatFrame_AddMessageEventFilter("CHAT_MSG_WHISPER", filter) end
        elseif event == "PLAYER_LOGIN" then
            C.RequestGuildRoster()
            C.After(8, M.Hello)
            if D.fromInbox then
                -- A new sheet arrived from the companion app: say so, and (if I'm an officer) share it.
                local s = D.db.sheet
                C.After(15, function()
                    ns.Print("Loaded the DKP sheet approved " .. ns.When(s.at) .. " from the companion app.")
                    local rank = C.MyGuildRank()
                    if rank and rank <= 1 then M.SendSheet() end
                end)
            end
        elseif event == "CHAT_MSG_ADDON" then
            M.OnMessage(...)
        elseif event == "CHAT_MSG_WHISPER" then
            local msg, sender = ...
            local lineID = select(11, ...)
            if A.OnWhisper(sender, msg) and lineID then hold[lineID] = true end
        elseif event == "LOOT_READY" then
            A.OnLootReady()
        elseif event == "GET_ITEM_INFO_RECEIVED" then
            UI.Refresh()
        end
    end, ...)
    if not ok then D.LogError(err) end
end)
