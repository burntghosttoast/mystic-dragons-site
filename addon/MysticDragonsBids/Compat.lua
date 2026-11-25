-- Mystic Dragons Bids: every call into the game goes through this file.
-- When a patch changes something, this is the one place to fix it. Each function checks the
-- game API exists before using it, so a missing call turns one feature off instead of breaking all of it.
--
-- WoW: Forever facts this file is built around (build 1.60.1, interface 16001):
--   * Forever runs the retail UI and API, with Master Loot (Enum.LootMethod.Masterlooter).
--   * Names have a surname with a space ("Swift Arrow"). UnitName gives the first name only; the
--     roster, chat and addon messages give the whole name; /w and SendChatMessage want a hyphen for the space.
--   * Chat lines (whispers, raid warnings) an addon sends from a timer or an event are silently dropped.
--     Only lines sent during a click get through. Addon messages are fine.
--   * During a boss fight, chat can arrive as "secret" values that addon code may not read.
--   * The server throttles more than about 30 whispers a minute.
local _, ns = ...
local C = {}
ns.C = C

C.VERSION = "0.1.2"
C.PREFIX = "MDBids"

local function has(f) return type(f) == "function" end

-- Secret values (retail system on Forever): true when any argument can't be read by addon code.
function C.IsSecret(...)
    if not has(issecretvalue) then return false end
    for i = 1, select("#", ...) do
        if issecretvalue((select(i, ...))) then return true end
    end
    return false
end

-- A name the way the site writes it: "Swift Arrow". Hyphens (the whisper form) become spaces,
-- extra spaces go, and every word keeps the game's capitals.
function C.Norm(name)
    if type(name) ~= "string" or C.IsSecret(name) then return nil end
    name = name:gsub("%-", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    if name == "" then return nil end
    return name
end
function C.Key(name) local n = C.Norm(name); return n and n:lower() or nil end

-- The form /w and SendChatMessage take: the space as a hyphen.
function C.WhisperName(name) return (C.Norm(name) or ""):gsub(" ", "-") end

-- My full name ("Swift Arrow"), not the first name UnitName gives on Forever.
function C.PlayerName()
    if has(UnitFullName) then
        local first, second = UnitFullName("player")
        if not C.IsSecret(first, second) and first and second and second ~= "" and not second:find("%.") then
            return C.Norm(first .. " " .. second)
        end
    end
    return C.Norm(has(UnitName) and UnitName("player") or nil)
end

function C.InRaid() return has(IsInRaid) and IsInRaid() or false end
function C.InGroup() return has(IsInGroup) and IsInGroup() or false end
function C.GroupChannel() return C.InRaid() and "RAID" or (C.InGroup() and "PARTY" or nil) end

-- Everyone in the group by full name, plus whether that list could be read at all.
function C.GroupNames()
    local out, ok = {}, true
    if C.InRaid() and has(GetRaidRosterInfo) and has(GetNumGroupMembers) then
        for i = 1, GetNumGroupMembers() do
            local name = GetRaidRosterInfo(i)
            if C.IsSecret(name) or not name then ok = false else out[C.Key(name)] = C.Norm(name) end
        end
    else
        local me = C.PlayerName(); if me then out[C.Key(me)] = me end
        if has(GetNumSubgroupMembers) then
            for i = 1, GetNumSubgroupMembers() do
                local n, s = has(UnitFullName) and UnitFullName("party" .. i)
                if C.IsSecret(n, s) or not n then ok = false
                else local full = C.Norm(s and s ~= "" and not s:find("%.") and (n .. " " .. s) or n); out[C.Key(full)] = full end
            end
        end
    end
    return out, ok
end

-- Whether I'm the master looter (or alone, for solo testing).
function C.IsMasterLooter()
    if not C.InGroup() then return true end
    if has(GetLootMethod) then
        local method, partyID, raidID = GetLootMethod()
        if method == "master" then return partyID == 0 or (raidID and has(UnitIsUnit) and UnitIsUnit("raid" .. raidID, "player")) or false end
    end
    if C_PartyInfo and has(C_PartyInfo.GetLootMethod) and Enum and Enum.LootMethod then
        local method, partyID, raidID = C_PartyInfo.GetLootMethod()
        if method == Enum.LootMethod.Masterlooter then return partyID == 0 or (raidID and UnitIsUnit("raid" .. raidID, "player")) or false end
    end
    return false
end

-- Whether I can post to raid warning (leader or assistant); otherwise announcements go to raid chat.
function C.CanRaidWarn()
    if not C.InRaid() then return false end
    return (has(UnitIsGroupLeader) and UnitIsGroupLeader("player")) or (has(UnitIsGroupAssistant) and UnitIsGroupAssistant("player")) or false
end

-- Guild rank index (0 GM, 1 officer). Used to trust a balance sheet only from officers.
-- Ask the server for the guild roster (the game only fills it in when asked).
function C.RequestGuildRoster()
    if C_GuildInfo and has(C_GuildInfo.GuildRoster) then C_GuildInfo.GuildRoster()
    elseif has(GuildRoster) then GuildRoster() end
end
function C.GuildRankOf(name)
    if not (has(GetNumGuildMembers) and has(GetGuildRosterInfo)) then return nil end
    local key = C.Key(name)
    for i = 1, GetNumGuildMembers() do
        local n, _, rankIndex = GetGuildRosterInfo(i)
        if n and not C.IsSecret(n) and C.Key(n) == key then return rankIndex end
    end
    return nil
end
function C.MyGuildRank() return C.GuildRankOf(C.PlayerName() or "") end

-- Item info. Returns name, link, quality, icon; nil until the game has the item cached.
function C.ItemInfo(item)
    local get = (C_Item and C_Item.GetItemInfo) or GetItemInfo
    if not has(get) then return nil end
    local name, link, quality, _, _, _, _, _, _, icon = get(item)
    return name, link, quality, icon
end
function C.ItemIcon(item)
    if C_Item and has(C_Item.GetItemIconByID) and tonumber(item) then return C_Item.GetItemIconByID(tonumber(item)) end
    local _, _, _, icon = C.ItemInfo(item); return icon
end
function C.ItemIdFromLink(link)
    if type(link) ~= "string" or C.IsSecret(link) then return nil end
    return tonumber(link:match("item:(%d+)"))
end

-- Loot window
function C.NumLootItems() return has(GetNumLootItems) and GetNumLootItems() or 0 end
function C.LootSlot(slot)
    if not has(GetLootSlotLink) then return nil end
    local link = GetLootSlotLink(slot)
    if not link or C.IsSecret(link) then return nil end
    local quality
    if has(GetLootSlotInfo) then local _, _, _, _, q = GetLootSlotInfo(slot); quality = q end
    return link, quality
end

-- Hand an item from the open loot window to a player. Returns true when the game took it.
function C.GiveLoot(slot, name)
    if not (has(GiveMasterLoot) and has(GetMasterLootCandidate) and slot) then return false, "Master loot isn't available." end
    local want = C.Key(name)
    for i = 1, 40 do
        local cand = GetMasterLootCandidate(slot, i)
        if cand and not C.IsSecret(cand) and C.Key(cand) == want then GiveMasterLoot(slot, i); return true end
    end
    return false, "They aren't eligible for that item (out of range, or the loot window closed)."
end

-- Addon messages. Fine from events and timers on Forever.
function C.RegisterPrefix()
    local reg = (C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix) or RegisterAddonMessagePrefix
    if has(reg) then reg(C.PREFIX) end
end
function C.SendAddon(msg, channel, target)
    local send = (C_ChatInfo and C_ChatInfo.SendAddonMessage) or SendAddonMessage
    if not has(send) or not channel then return false end
    if C_ChatInfo and has(C_ChatInfo.InChatMessagingLockdown) and C_ChatInfo.InChatMessagingLockdown() then return false, "lockdown" end
    send(C.PREFIX, msg, channel, channel == "WHISPER" and C.WhisperName(target) or nil)
    return true
end

-- Chat lines. Only call these from a click (see the top of this file).
function C.SendChat(text, channel, target)
    if not has(SendChatMessage) or not text then return false end
    if channel == "RAID_WARNING" and not C.CanRaidWarn() then channel = C.GroupChannel() end
    if not channel then print("|cffCDB07CMD Bids|r " .. text); return true end
    if channel == "WHISPER" then target = C.WhisperName(target) end
    SendChatMessage(text, channel, nil, target)
    return true
end

function C.Now() return has(GetServerTime) and GetServerTime() or time() end
function C.After(sec, fn) if C_Timer and has(C_Timer.After) then C_Timer.After(sec, fn) end end

-- What /mdkp check reports: every game call this addon uses, and whether this patch has it.
function C.Check()
    local list = {
        { "Addon messages", (C_ChatInfo and C_ChatInfo.SendAddonMessage) or SendAddonMessage },
        { "Master loot: give item", GiveMasterLoot },
        { "Master loot: candidates", GetMasterLootCandidate },
        { "Loot window", GetLootSlotLink },
        { "Item info", (C_Item and C_Item.GetItemInfo) or GetItemInfo },
        { "Raid roster", GetRaidRosterInfo },
        { "Guild roster", GetGuildRosterInfo },
        { "Chat", SendChatMessage },
        { "Chat filter", ChatFrame_AddMessageEventFilter },
        { "Full names", UnitFullName },
        { "Timers", C_Timer and C_Timer.After },
    }
    local out = {}
    for _, row in ipairs(list) do out[#out + 1] = { row[1], has(row[2]) } end
    return out
end
