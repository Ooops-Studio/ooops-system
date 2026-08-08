export const redisCacheSetManyScript = `
local registry = KEYS[1]
local now = ARGV[1]
redis.call('ZREMRANGEBYSCORE', registry, '-inf', now)
for index = 2, #KEYS do
  local offset = 2 + ((index - 2) * 4)
  redis.call('SET', KEYS[index], ARGV[offset])
  local ttl = tonumber(ARGV[offset + 1])
  if ttl > 0 then redis.call('PEXPIRE', KEYS[index], ttl) end
  redis.call('ZADD', registry, ARGV[offset + 3], ARGV[offset + 2])
end
return #KEYS - 1
`

export const redisCacheGetManyBoundedScript = `
local registry = KEYS[1]
local maxRecordBytes = tonumber(ARGV[1])
local remainingBytes = tonumber(ARGV[2])
local result = {}
for index = 2, #KEYS do
  local member = ARGV[index + 1]
  local size = redis.call('STRLEN', KEYS[index])
  local exists = size > 0 or redis.call('EXISTS', KEYS[index]) == 1
  if not exists then
    redis.call('ZREM', registry, member)
    result[#result + 1] = 0
    result[#result + 1] = ''
  elseif size > maxRecordBytes then
    redis.call('DEL', KEYS[index])
    redis.call('ZREM', registry, member)
    result[#result + 1] = 2
    result[#result + 1] = ''
  elseif size > remainingBytes then
    result[#result + 1] = 3
    result[#result + 1] = ''
  else
    result[#result + 1] = 1
    result[#result + 1] = redis.call('GET', KEYS[index])
    remainingBytes = remainingBytes - size
  end
end
return result
`

export const redisCacheDeleteManyScript = `
local registry = KEYS[1]
local removed = 0
for index = 2, #KEYS do
  removed = removed + redis.call('DEL', KEYS[index])
  redis.call('ZREM', registry, ARGV[index - 1])
end
return removed
`

export const redisCacheDeleteIfValuesScript = `
local registry = KEYS[1]
local removed = 0
local deletedTotal = 0
local retained = 0
local missing = 0
for index = 2, #KEYS do
  local offset = 1 + ((index - 2) * 3)
  local member = ARGV[offset]
  local expected = ARGV[offset + 1]
  local countRemoval = tonumber(ARGV[offset + 2])
  if redis.call('GET', KEYS[index]) == expected then
    local deleted = redis.call('DEL', KEYS[index])
    deletedTotal = deletedTotal + deleted
    redis.call('ZREM', registry, member)
    if countRemoval == 1 then removed = removed + deleted end
  elseif redis.call('EXISTS', KEYS[index]) == 0 then
    redis.call('ZREM', registry, member)
    missing = missing + 1
  else
    retained = retained + 1
  end
end
return {removed, deletedTotal, retained, missing}
`

export const redisCacheListKeysScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local m = tonumber(ARGV[4])
if redis.call('ZCARD', KEYS[1]) > m and redis.call('OBJECT', 'ENCODING', KEYS[1]) ~= 'skiplist' then
  return {}
end
local s = redis.call('ZSCAN', KEYS[1], ARGV[2], 'COUNT', ARGV[3])
if #s[2] > m * 2 then return {} end
local r = {s[1]}
for i = 1, #s[2], 2 do r[#r + 1] = s[2][i] end
return r
`
