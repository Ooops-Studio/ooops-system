export const REDIS_NATIVE_SCRIPT = String.raw`
local p = KEYS[1] local op = ARGV[1]
local a = cjson.decode(ARGV[2] or '{}') local call = redis.call local cap=4194304
local runs, schedules, dead, idem = p..':runs', p..':schedules', p..':dead', p..':idempotency' local delayed, ready, leases = p..':delayed', p..':ready', p..':leases' local scheduleDue, scheduleProcessing = p..':schedule-due', p..':schedule-processing'
local sdm=p..':sd2' local scheduleTokens, scheduleHashes = p..':schedule-tokens', p..':schedule-hashes' local paused, terminal, marker, legacy = p..':paused', p..':terminal', p..':native-v2', p..':snapshot'
local queues, runningCount, runningTasks = p..':queues', p..':running-count', p..':running-tasks' local rmk = p..':running-counts-v2' local rcur, rrc, rrt = p..':running-counts-v2-cursor', p..':running-counts-v2-rebuild-count', p..':running-counts-v2-rebuild-tasks'
local rmeta = p..':running-meta-v2' local idemExpiry, readyGroups = p..':idempotency-expiry', p..':ready-groups' local queueStatusCounts, queueStatsMarker = p..':queue-status-counts', p..':queue-stats-v1'
local runOrder, runOrderMarker = p..':idx:runs-order', p..':run-order-v1' local queueStatsCursor, queueStatsRebuildCounts = p..':queue-stats-v1-cursor', p..':queue-stats-v1-rebuild-counts' local runOrderCursor = p..':run-order-v1-cursor'
local deadOrder, deadOrderMarker = p..':dead-order', p..':dead-order-v1' local tmk = p..':terminal-v3' local tcur = p..':terminal-v3-c'
local readyMarker, readyCursor = p..':ready-v3', p..':ready-v3-c' local runnableMeta = p..':runnable-meta-v2' local scheduleOrder, scheduleOrderMarker = p..':schedule-order', p..':schedule-order-v1'
local scheduleOrderCursor, sdr = p..':schedule-order-v1-cursor', p..':sd2-r' local deadByRun, deadMeta, deadIndexesMarker = p..':dead-by-run', p..':dead-meta-v3', p..':dead-indexes-v3' local deadIndexesCursor = p..':dead-indexes-v3-cursor'
 local function d(value) if not value then return nil end
return cjson.decode(value) end
local function sd(value) if not value then return nil end
local ok,result=pcall(cjson.decode,value)
if not ok then return nil end
return result end
local function e(value) return cjson.encode(value) end
local function ea(value) if #value==0 then return '[]' end
return cjson.encode(value) end
local function tc(value) local count=0
for _ in pairs(value or {}) do count=count+1 end
return count end
local function sid(value,maximum) return type(value)=='string' and string.len(value)>=1 and string.len(value)<=maximum and string.match(value,'^[A-Za-z][A-Za-z0-9_.-]*$')~=nil end
local function validI(value) return type(value)=='table' and type(value.runId)=='string' and string.len(value.runId)>=1
and string.len(value.runId)<=256 and type(value.checksum)=='string' and string.len(value.checksum)>=1 and string.len(value.checksum)<=256 and type(value.expiresAt)=='number' and value.expiresAt>=0
and value.expiresAt<=99999999999999 and value.expiresAt==math.floor(value.expiresAt) end
local function w(value,minimum,maximum)
return type(value)=='number' and value>=minimum and value<=maximum and value==math.floor(value) end
local function vrr(value,id)
if type(value)~='table' or type(value.id)~='string' or value.id~=id or string.len(value.id)<1 or string.len(value.id)>256 or not sid(value.task,128) or not sid(value.queue,64)
or type(value.payload)~='table' or (value.status~='queued' and value.status~='retryable') or not w(value.createdAt,0,99999999999999) or not w(value.updatedAt,value.createdAt,99999999999999)
or not w(value.runAt,0,99999999999999) or not w(value.priority,-2147483648,2147483647) or not w(value.attempt,0,100) or not w(value.maxAttempts,1,100)
or value.attempt>value.maxAttempts or type(value.retryPolicy)~='table' or value.retryPolicy.attempts~=value.maxAttempts or not w(value.retryPolicy.baseDelayMs,0,2147483647)
or value.leaseOwner~=nil or value.leaseToken~=nil or value.leaseExpiresAt~=nil or value.lastHeartbeatAt~=nil or value.terminalAt~=nil or value.terminalExpiresAt~=nil then return false end
return (value.status=='queued' and value.attempt==0)
or (value.status=='retryable' and value.attempt>=1 and value.attempt<value.maxAttempts) end
local function deq(left,right)
if type(left)~=type(right) then return false end
if type(left)~='table' then return left==right end
for key,value in pairs(left) do if not deq(value,right[key]) then return false end
end
for key,_ in pairs(right) do if left[key]==nil then return false end
end return true end
local function ts(status) return status == 'completed' or status == 'failed' or status == 'cancelled' or status == 'dead-lettered' end
local function ls(status) return status=='queued' or status=='running' or status=='retryable' end
local function sc(value) if value==nil then return '~' end
return value end
local function sik(schedule) local queue=sc(schedule.queue)
local task=schedule.task
local enabled=schedule.enabled==false and '0' or '1' return {scheduleOrder,p..':idx:schedule-queue-order:'..queue,p..':idx:schedule-task-order:'..task,p..':idx:schedule-enabled-order:'..enabled,p..':idx:schedule-queue-task-order:'..queue..':'..task,p..':idx:schedule-queue-enabled-order:'..queue..':'..enabled,p..':idx:schedule-task-enabled-order:'..task..':'..enabled,p..':idx:schedule-queue-task-enabled-order:'..queue..':'..task..':'..enabled}
end local function asi(schedule) for _,key in ipairs(sik(schedule)) do call('ZADD',key,0,schedule.id) end
end local function rsi(schedule) if schedule then for _,key in ipairs(sik(schedule)) do call('ZREM',key,schedule.id) end
end end
local function ssd() call('SET',sdm,call('ZCARD',scheduleDue)+call('ZCARD',scheduleProcessing)) end
local function ps(schedule) local previous=d(call('HGET',schedules,schedule.id));rsi(previous)
call('HSET',schedules,schedule.id,e(schedule));asi(schedule) end
local function ds(item) return {id=item.id,runId=item.runId,queue=item.queue,task=item.task,failureCode=item.failureCode,reason=item.reason,error=item.error,attempts=item.attempts,failedAt=item.failedAt} end
local function pd(item) call('HSET',dead,item.id,e(item))
call('HSET',deadMeta,item.id,e(ds(item)))
call('ZADD',deadOrder,item.failedAt,item.id)
call('HSET',deadByRun,item.runId,item.id) end
local function rd(item,key) call('HDEL',dead,key)
call('HDEL',deadMeta,key)
call('ZREM',deadOrder,key)
if item and call('HGET',deadByRun,item.runId)==key then call('HDEL',deadByRun,item.runId) end
end local function rm(run) return string.format('%016.0f',run.runAt)..':'..run.id end
local function rid(member) if string.sub(member,17,17)==':' then return string.sub(member,18) end
return member end
local function rui(run) return {id=run.id,queue=run.queue,task=run.task,runAt=run.runAt,priority=run.priority or 0} end
local function vr(value,id)
return type(value)=='table' and value.id==id and sid(value.queue,64) and sid(value.task,128) and w(value.runAt,0,99999999999999) and w(value.priority or 0,-2147483648,2147483647)
end local function ldr(id) local info=sd(call('HGET',runnableMeta,id))
if vr(info,id) then return info end
local run=call('HSTRLEN',runs,id)<=cap and sd(call('HGET',runs,id)) or nil if vrr(run,id) then
info=rui(run)
call('HSET',runnableMeta,id,e(info))
return info end
call('HDEL',runnableMeta,id)
return nil
end local function dr(id,info) call('ZREM',delayed,id)
call('ZREM',ready,id)
call('HDEL',runnableMeta,id)
if vr(info,id) then local member=rm(info)
local group=info.queue..':'..info.task
local readyKey=p..':ready:'..group call('ZREM',ready,member)
call('ZREM',readyKey,id,member)
if call('ZCARD',readyKey)==0 then call('SREM',readyGroups,group) end
call('ZREM',p..':idx:queue-due:'..info.queue,id) end
call('SET',readyMarker,call('HLEN',runnableMeta)) end
local function va(value,id)
return type(value)=='table' and value.id==id and sid(value.task,128) and sid(value.queue,64) and value.status=='running' and w(value.createdAt,0,99999999999999)
and w(value.updatedAt,value.createdAt,99999999999999) and w(value.runAt,0,99999999999999) and w(value.priority,-2147483648,2147483647)
and w(value.attempt,1,100) and w(value.maxAttempts,1,100) and value.attempt<=value.maxAttempts and w(value.leaseExpiresAt,1,99999999999999) and (value.scheduleId==nil or type(value.scheduleId)=='string')
end local function ri(run) return {id=run.id,task=run.task,attempt=run.attempt,maxAttempts=run.maxAttempts,leaseExpiresAt=run.leaseExpiresAt} end
local function vai(value,id)
return type(value)=='table' and value.id==id and sid(value.task,128) and w(value.attempt,1,100) and w(value.maxAttempts,1,100) and value.attempt<=value.maxAttempts
and w(value.leaseExpiresAt,1,99999999999999) end
local function lda(id,run)
local info=sd(call('HGET',rmeta,id)) if vai(info,id) then return info end
if va(run,id) then
info=ri(run)
call('HSET',rmeta,id,e(info))
return info end
call('HDEL',rmeta,id)
return nil
end local function rri(run) if not run then return end
dr(run.id,rui(run))
call('ZREM',leases,run.id)
call('HDEL',rmeta,run.id)
call('ZREM',terminal,run.id)
call('SET',tmk,call('ZCARD',terminal)) end
local function ro(run)
if not run then return end
call('ZREM',runOrder,run.id)
call('ZREM',p..':idx:queue-order:'..run.queue,run.id)
call('ZREM',p..':idx:task-order:'..run.task,run.id)
call('ZREM',p..':idx:status-order:'..run.status,run.id)
call('ZREM',p..':idx:queue-task-order:'..run.queue..':'..run.task,run.id)
call('ZREM',p..':idx:queue-status-order:'..run.queue..':'..run.status,run.id)
call('ZREM',p..':idx:task-status-order:'..run.task..':'..run.status,run.id)
call('ZREM',p..':idx:queue-task-status-order:'..run.queue..':'..run.task..':'..run.status,run.id)
if run.scheduleId then call('ZREM',p..':idx:schedule-order:'..run.scheduleId,run.id)
call('ZREM',p..':idx:schedule-status-order:'..run.scheduleId..':'..run.status,run.id) end
end
local function ao(run) call('ZADD',runOrder,run.runAt,run.id)
call('ZADD',p..':idx:queue-order:'..run.queue,run.runAt,run.id)
call('ZADD',p..':idx:task-order:'..run.task,run.runAt,run.id)
call('ZADD',p..':idx:status-order:'..run.status,run.runAt,run.id)
call('ZADD',p..':idx:queue-task-order:'..run.queue..':'..run.task,run.runAt,run.id)
call('ZADD',p..':idx:queue-status-order:'..run.queue..':'..run.status,run.runAt,run.id)
call('ZADD',p..':idx:task-status-order:'..run.task..':'..run.status,run.runAt,run.id)
call('ZADD',p..':idx:queue-task-status-order:'..run.queue..':'..run.task..':'..run.status,run.runAt,run.id)
if run.scheduleId then call('ZADD',p..':idx:schedule-order:'..run.scheduleId,run.runAt,run.id)
call('ZADD',p..':idx:schedule-status-order:'..run.scheduleId..':'..run.status,run.runAt,run.id) end
end
local function rsx(run) if not run then return end
call('SREM',p..':idx:status:'..run.status,run.id); call('SREM',p..':idx:queue:'..run.queue,run.id); call('SREM',p..':idx:task:'..run.task,run.id)
if run.scheduleId then local live=p..':idx:schedule-live:'..run.scheduleId
call('SREM',p..':idx:schedule:'..run.scheduleId,run.id)
call('SREM',live,run.id)
call('SET',p..':idx:sl2:'..run.scheduleId,call('SCARD',live)) end
local field=run.queue..':'..run.status; local count=call('HINCRBY',queueStatusCounts,field,-1); if count<=0 then call('HDEL',queueStatusCounts,field) end
if call('SCARD',p..':idx:queue:'..run.queue)==0 and call('SISMEMBER',paused,run.queue)==0 then call('SREM',queues,run.queue) end
ro(run) end
local function asx(run)
call('SADD',p..':idx:status:'..run.status,run.id); call('SADD',p..':idx:queue:'..run.queue,run.id); call('SADD',p..':idx:task:'..run.task,run.id) if run.scheduleId then local live=p..':idx:schedule-live:'..run.scheduleId
call('SADD',p..':idx:schedule:'..run.scheduleId,run.id)
if not ts(run.status) then call('SADD',live,run.id) end
call('SET',p..':idx:sl2:'..run.scheduleId,call('SCARD',live)) end
call('HINCRBY',queueStatusCounts,run.queue..':'..run.status,1)
ao(run) end
local function ir(run)
call('SADD', queues, run.queue) if run.status == 'queued' or run.status == 'retryable' then call('ZADD', delayed, run.runAt, run.id)
call('HSET',runnableMeta,run.id,e(rui(run)))
call('SET',readyMarker,call('HLEN',runnableMeta))
call('ZADD',p..':idx:queue-due:'..run.queue,run.runAt,run.id) end
if run.status == 'running' and run.leaseExpiresAt then call('ZADD', leases, run.leaseExpiresAt, run.id)
call('HSET',rmeta,run.id,e(ri(run))) end
if ts(run.status) and run.terminalExpiresAt then call('ZADD', terminal, run.terminalExpiresAt, run.id)
call('SET',tmk,call('ZCARD',terminal)) end
end local function pr(run) local previous=d(call('HGET',runs,run.id)); rri(previous); rsx(previous); call('HSET', runs, run.id, e(run)); ir(run); asx(run) end
local function ridc(runId,exceptKey) if call('HLEN',idem)>10000 then error('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
local entries=call('HGETALL',idem)
local removals={}
for index=1,#entries,2 do local key=entries[index]
local record=sd(entries[index+1])
if not validI(record) then error('JOBS_IDEMPOTENCY_RECORD_INVALID') end
if key~=exceptKey and record.runId==runId then table.insert(removals,key) end
end for _,key in ipairs(removals) do call('HDEL',idem,key)
call('ZREM',idemExpiry,key) end
end
local function hrid(runId,exceptKey) if call('HLEN',idem)>10000 then error('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
local entries=call('HGETALL',idem)
local found=false
for index=1,#entries,2 do local key=entries[index]
local record=sd(entries[index+1])
if not validI(record) then error('JOBS_IDEMPOTENCY_RECORD_INVALID') end
if key~=exceptKey and record.runId==runId then found=true end
end return found end
local function vrc() local n=tonumber(call('GET',runningCount))
if not n or n~=call('HLEN',rmeta) or n~=call('ZCARD',leases) or n~=call('SCARD',p..':idx:status:running') then return false end
local total=0
for _,raw in ipairs(call('HVALS',runningTasks)) do local value=tonumber(raw)
if not w(value,1,10000) then return false end;total=total+value end
return total==n
end local function erc() if call('EXISTS',rmk)==1 then return end
error('JOBS_RUNNING_INDEX_REQUIRES_BACKFILL') end
local function lr(run)
if run and run.status == 'running' then erc() local active=call('DECR',runningCount)
if active<0 then call('SET',runningCount,'0') end
local taskActive=call('HINCRBY',runningTasks,run.task,-1)
if taskActive<=0 then call('HDEL',runningTasks,run.task) end
end end
local function la(info) if vai(info,info and info.id) then erc()
local active=call('DECR',runningCount)
if active<0 then call('SET',runningCount,'0') end
local taskActive=call('HINCRBY',runningTasks,info.task,-1)
if taskActive<=0 then call('HDEL',runningTasks,info.task) end
end
end local function ql(queue,now) local dueKey=p..':idx:queue-due:'..queue
for _=1,1000 do local oldest=call('ZRANGE',dueKey,0,0,'WITHSCORES')
if #oldest==0 then return 0 end
local run=d(call('HGET',runs,oldest[1]))
local score=tonumber(oldest[2])
if run and run.queue==queue and (run.status=='queued' or run.status=='retryable') and run.runAt==score then return score<=now and now-score or 0 end
call('ZREM',dueKey,oldest[1]) end
error('JOBS_QUEUE_DUE_REPAIR_LIMIT_EXCEEDED') end
local function gd()
if call('EXISTS', legacy) == 1 and call('EXISTS', marker) == 0 then return redis.error_reply('JOBS_LEGACY_SNAPSHOT_REQUIRES_MIGRATION') end
end
if op == 'migrate' then if call('EXISTS', marker) == 1 then return e({migrated=false, already=true}) end
local raw = a.snapshot or call('GET', legacy); if not raw then call('SET',marker,'migrated')
call('SET',runningCount,'0')
call('SET',rmk,'1')
call('SET',queueStatsMarker,'1')
call('SET',runOrderMarker,'1')
call('SET',deadOrderMarker,'1')
call('SET',tmk,'0')
call('SET',readyMarker,'0')
call('SET',scheduleOrderMarker,'1')
call('SET',deadIndexesMarker,'1')
return e({migrated=false, already=false, runs=0}) end
if call('HLEN',runs)>0 or call('HLEN',schedules)>0 or call('HLEN',dead)>0 or call('HLEN',idem)>0 or call('SCARD',paused)>0 or call('EXISTS',delayed,ready,leases,scheduleDue,scheduleProcessing,scheduleTokens,scheduleHashes,queues,runningCount,runningTasks,idemExpiry,readyGroups,queueStatusCounts,runOrder,deadOrder)>0 then return redis.error_reply('JOBS_NATIVE_MIGRATION_CONFLICT') end
local snapshot = d(raw); if not snapshot or snapshot.version ~= 1 then return redis.error_reply('JOBS_UNSUPPORTED_SNAPSHOT') end
local state = d(snapshot.data)
if tc(state.runs)>10000 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
if tc(state.schedules)>10000 then return redis.error_reply('JOBS_SCHEDULE_LIMIT_EXCEEDED') end
if tc(state.deadLetters)>10000 then return redis.error_reply('JOBS_DEAD_LETTER_LIMIT_EXCEEDED') end
if tc(state.idempotency)>10000 then return redis.error_reply('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
local migrationQueues={}
for _,run in pairs(state.runs or {}) do migrationQueues[run.queue]=true end
for _,queue in ipairs(state.queuePaused or {}) do migrationQueues[queue]=true end
if tc(migrationQueues)>1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
local runCount = 0 for id,run in pairs(state.runs or {}) do run.id=id; pr(run); if run.status=='running' then call('INCR',runningCount); call('HINCRBY',runningTasks,run.task,1) end; runCount=runCount+1 end
for id,schedule in pairs(state.schedules or {}) do schedule.id=id; ps(schedule); if schedule.enabled ~= false and schedule.nextRunAt then call('ZADD', scheduleDue, schedule.nextRunAt, id) end
end
for id,item in pairs(state.deadLetters or {}) do item.id=id;pd(item) end
for key,item in pairs(state.idempotency or {}) do call('HSET', idem, key, e(item)); call('ZADD',idemExpiry,item.expiresAt,key) end
for _,queue in ipairs(state.queuePaused or {}) do call('SADD',paused,queue)
call('SADD',queues,queue) end
call('SET', marker, 'migrated')
call('SET',rmk,'1'); call('SET',queueStatsMarker,'1')
call('SET',runOrderMarker,'1')
call('SET',deadOrderMarker,'1')
call('SET',tmk,call('ZCARD',terminal))
call('SET',readyMarker,call('HLEN',runnableMeta))
call('SET',scheduleOrderMarker,'1')
call('SET',deadIndexesMarker,'1'); if a.deleteLegacy then call('DEL', legacy) end
return e({migrated=true, already=false, runs=runCount}) end
 if op == 'verifyMigration' then if call('GET',marker)~='migrated' then return 'false' end
local snapshot=d(a.snapshot)
if not snapshot or snapshot.version~=1 then return redis.error_reply('JOBS_UNSUPPORTED_SNAPSHOT') end
local state=d(snapshot.data) for id,expected in pairs(state.runs or {}) do local item=sd(call('HGET',runs,id))
if not item or not deq(item,expected) then return 'false' end
end
for id,expected in pairs(state.schedules or {}) do local item=sd(call('HGET',schedules,id))
if item and expected.nextRunAt==nil then expected.nextRunAt=item.nextRunAt end
if not item or not deq(item,expected) then return 'false' end
end for id,expected in pairs(state.deadLetters or {}) do local item=sd(call('HGET',dead,id))
if not item or not deq(item,expected) then return 'false' end
end for key,expected in pairs(state.idempotency or {}) do local item=sd(call('HGET',idem,key))
if not item or not deq(item,expected) then return 'false' end
end
for _,queue in ipairs(state.queuePaused or {}) do if call('SISMEMBER',paused,queue)==0 then return 'false' end
end return 'true' end
 if op == 'initialize' then if call('EXISTS',marker)==0 then
local empty=call('HLEN',runs)==0 and call('HLEN',schedules)==0 and call('HLEN',dead)==0 and call('HLEN',idem)==0 and call('SCARD',paused)==0 and call('EXISTS',delayed,ready,leases,scheduleDue,scheduleProcessing,scheduleTokens,scheduleHashes,queues,runningCount,runningTasks,idemExpiry,readyGroups,queueStatusCounts,runOrder,deadOrder)==0 if not empty then return redis.error_reply('JOBS_NATIVE_INITIALIZATION_CONFLICT') end
call('SET',marker,'initialized')
call('SET',runningCount,'0')
call('DEL',runningTasks)
call('SET',rmk,'1')
call('SET',queueStatsMarker,'1')
call('SET',runOrderMarker,'1')
call('SET',deadOrderMarker,'1')
call('SET',tmk,'0')
call('SET',readyMarker,'0')
call('SET',scheduleOrderMarker,'1')
call('SET',deadIndexesMarker,'1')
end return 'true' end
 local guarded = gd(); if guarded then return guarded end
if op == 'append' then
local run = a.run local pendingIdempotency = nil if a.idempotency then
local existing = d(call('HGET', idem, a.idempotency.key)) if existing and existing.expiresAt > run.createdAt then if existing.checksum ~= a.idempotency.checksum then return redis.error_reply('JOBS_IDEMPOTENCY_CHECKSUM_MISMATCH') end
local existingRun = d(call('HGET', runs, existing.runId)) if existingRun and existingRun.id ~= existing.runId then return redis.error_reply('JOBS_IDEMPOTENCY_RUN_MISMATCH') end
if existingRun then return e({run=existingRun, existing=true}) end
return redis.error_reply('JOBS_IDEMPOTENCY_RUN_MISSING') end
pendingIdempotency = a.idempotency
end if call('HEXISTS',runs,run.id)==1 then return redis.error_reply('JOBS_RUN_ID_EXISTS') end
if call('HLEN',runs)>=10000 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
if call('SISMEMBER',queues,run.queue)==0 and call('SCARD',queues)>=1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
if pendingIdempotency and call('HEXISTS',idem,pendingIdempotency.key)==0 and call('HLEN',idem)>=10000 then return redis.error_reply('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
if pendingIdempotency then pendingIdempotency.runId=run.id; call('HSET', idem, pendingIdempotency.key, e(pendingIdempotency)); call('ZADD',idemExpiry,pendingIdempotency.expiresAt,pendingIdempotency.key) end
pr(run); return e({run=run, existing=false})
elseif op == 'getRun' then return call('HGET', runs, a.id)
elseif op == 'runSlots' then local count=call('HLEN',runs)
if count>10000 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
return tostring(10000-count)
elseif op == 'fitScheduleCommits' then local rs=10000-call('HLEN',runs)
local qs=1000-call('SCARD',queues) if rs<0 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
if qs<0 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
local r={}
local f='' for _,commit in ipairs(a.commits or {}) do
local n=commit.runCount or 0
local ok=n<=rs local adds={}
local added=0 for _,queue in ipairs(commit.queues or {}) do
if call('SISMEMBER',queues,queue)==0 and not r[queue] and not adds[queue] then adds[queue]=true;added=added+1 end
end ok=ok and added<=qs
if ok then for queue in pairs(adds) do r[queue]=true end;rs=rs-n;qs=qs-added;f=f..'1' else f=f..'0' end
end return f
elseif op == 'listScheduleLive' then
local readyKey=p..':idx:sl2:'..a.scheduleId
local liveKey=p..':idx:schedule-live:'..a.scheduleId
local expected=tonumber(call('GET',readyKey))
local count=call('SCARD',liveKey) if not expected or expected~=count then local cursor='0'
call('DEL',liveKey);repeat local page=call('HSCAN',runs,cursor,'COUNT',100);cursor=page[1]
for index=2,#page[2],2 do local raw=page[2][index]
local run=string.len(raw)<=cap and sd(raw) or nil
if run and run.scheduleId==a.scheduleId and ls(run.status) then call('SADD',liveKey,run.id) end
end until cursor=='0';count=call('SCARD',liveKey)
call('SET',readyKey,count) end
if count>10000 then return redis.error_reply('JOBS_SCHEDULE_LIVE_LIMIT_EXCEEDED') end
local result={}
for _,id in ipairs(call('SMEMBERS',liveKey)) do local raw=call('HGET',runs,id)
local run=raw and string.len(raw)<=cap and sd(raw) or nil
if run and run.id==id and run.scheduleId==a.scheduleId and ls(run.status) then table.insert(result,id) else call('SREM',liveKey,id) end
end
call('SET',readyKey,call('SCARD',liveKey)) return ea(result)
elseif op == 'bro' then
if call('EXISTS',runOrderMarker)==1 then return 'true' end
if call('HLEN',runs)>10000 then return redis.error_reply('JOBS_INDEX_REBUILD_LIMIT_EXCEEDED') end
local cursor=call('GET',runOrderCursor) or '0'
local processed=0
local processedBytes=0
repeat local page=call('HSCAN',runs,cursor,'COUNT',1);cursor=page[1] for index=2,#page[2],2 do local raw=page[2][index]
local run=d(raw)
if run then ao(run) end;processed=processed+1;processedBytes=processedBytes+string.len(raw) end
until cursor=='0' or processed>=16 or processedBytes>=cap if cursor=='0' then call('DEL',runOrderCursor)
call('SET',runOrderMarker,'1')
return 'true' end
call('SET',runOrderCursor,cursor)
return 'false'
elseif op == 'brc' then if call('EXISTS',rmk)==1 then if vrc() then return 'true' end
call('DEL',rmk,rcur,rrc,rrt) end
if call('HLEN',runs)>10000 then return redis.error_reply('JOBS_INDEX_REBUILD_LIMIT_EXCEEDED') end
local storedCursor=call('GET',rcur)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0 if not storedCursor then call('SET',rrc,'0')
call('DEL',rrt,rmeta,leases,p..':idx:status:running') end
repeat
local page=call('HSCAN',runs,cursor,'COUNT',1);cursor=page[1]
local decoded={} for index=2,#page[2],2 do local raw=page[2][index]
local run=sd(raw)
if type(run)~='table' or type(run.id)~='string' or type(run.status)~='string' or (run.status=='running' and type(run.task)~='string') then call('SET',rrc,'0')
call('DEL',rrt,rcur,rmeta)
return redis.error_reply('JOBS_RUN_RECORD_INVALID') end
table.insert(decoded,run);processed=processed+1;processedBytes=processedBytes+string.len(raw) end
for _,run in ipairs(decoded) do if run.status=='running' then call('INCR',rrc)
call('HINCRBY',rrt,run.task,1)
call('SADD',p..':idx:status:running',run.id)
if run.leaseExpiresAt then call('HSET',rmeta,run.id,e(ri(run)))
call('ZADD',leases,run.leaseExpiresAt,run.id) end
end end
until cursor=='0' or processed>=16 or processedBytes>=cap if cursor=='0' then call('SET',runningCount,call('GET',rrc) or '0')
if call('HLEN',rrt)>0 then call('RENAME',rrt,runningTasks) else call('DEL',runningTasks) end
call('DEL',rrc,rcur)
call('SET',rmk,'1')
return 'true' end
call('SET',rcur,cursor)
return 'false'
elseif op == 'bqs' then if call('EXISTS',queueStatsMarker)==1 then return 'true' end
if call('HLEN',runs)>10000 then return redis.error_reply('JOBS_INDEX_REBUILD_LIMIT_EXCEEDED') end
local storedCursor=call('GET',queueStatsCursor)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0 if not storedCursor then call('DEL',queueStatsRebuildCounts)
for _,queue in ipairs(call('SMEMBERS',queues)) do call('DEL',p..':idx:queue-due:'..queue) end
end repeat
local page=call('HSCAN',runs,cursor,'COUNT',1);cursor=page[1]
local decoded={} for index=2,#page[2],2 do local id=page[2][index-1]
local raw=page[2][index]
local run=sd(raw)
local valid=type(run)=='table' and run.id==id and type(run.queue)=='string' and type(run.status)=='string' and ((run.status~='queued' and run.status~='retryable') or type(run.runAt)=='number')
if valid then table.insert(decoded,run) end;processed=processed+1;processedBytes=processedBytes+string.len(raw) end
for _,run in ipairs(decoded) do call('HINCRBY',queueStatsRebuildCounts,run.queue..':'..run.status,1)
if run.status=='queued' or run.status=='retryable' then call('ZADD',p..':idx:queue-due:'..run.queue,run.runAt,run.id) end
end
until cursor=='0' or processed>=16 or processedBytes>=cap if cursor=='0' then if call('HLEN',queueStatsRebuildCounts)>0 then call('RENAME',queueStatsRebuildCounts,queueStatusCounts) else call('DEL',queueStatusCounts) end
call('DEL',queueStatsCursor)
call('SET',queueStatsMarker,'1')
return 'true' end
call('SET',queueStatsCursor,cursor)
return 'false'
elseif op == 'listRuns' then if call('EXISTS',runOrderMarker)==0 then return redis.error_reply('JOBS_RUN_ORDER_INDEX_REQUIRES_BACKFILL') end
local q=a.query or {}
local status=type(q.status)=='string' and q.status or nil
local base=runOrder
if q.scheduleId and status then base=p..':idx:schedule-status-order:'..q.scheduleId..':'..status
elseif q.scheduleId then base=p..':idx:schedule-order:'..q.scheduleId
elseif q.queue and q.task and status then base=p..':idx:queue-task-status-order:'..q.queue..':'..q.task..':'..status
elseif q.queue and q.task then base=p..':idx:queue-task-order:'..q.queue..':'..q.task
elseif q.queue and status then base=p..':idx:queue-status-order:'..q.queue..':'..status
elseif q.task and status then base=p..':idx:task-status-order:'..q.task..':'..status
elseif q.queue then base=p..':idx:queue-order:'..q.queue
elseif q.task then base=p..':idx:task-order:'..q.task
elseif status then base=p..':idx:status-order:'..status end
local offset=math.max(0,q.offset or 0)
local limit=math.min(1000,math.max(0,q.limit or 100))
local result={}
local cursor=0
local matched=0
local resultBytes=0 if call('ZCARD',base)>10000 then return redis.error_reply('JOBS_RUN_INDEX_LIMIT_EXCEEDED') end
while #result<limit do local pageSize=500
local ids=call('ZRANGE',base,cursor,cursor+pageSize-1)
if #ids==0 then break end
local retained=0
for _,id in ipairs(ids) do local value=call('HGET',runs,id)
local run=d(value) if run then local statusOk=not q.status or (type(q.status)=='string' and run.status==q.status)
if (not q.queue or run.queue==q.queue) and (not q.task or run.task==q.task) and (not q.scheduleId or run.scheduleId==q.scheduleId) and statusOk then if matched>=offset then if resultBytes+string.len(value)>60*1024*1024 then return ea(result) end;resultBytes=resultBytes+string.len(value)
table.insert(result,value) end;matched=matched+1 end;retained=retained+1 else call('ZREM',base,id) end
if #result>=limit then break end
end if #ids<pageSize then break end;cursor=cursor+retained
end return ea(result)
elseif op == 'bri' then
if call('EXISTS',readyMarker)==0 and call('EXISTS',readyCursor)==0 then local n=call('HLEN',runnableMeta)
if n>0 and n==call('ZCARD',delayed)+call('ZCARD',ready) then call('SET',readyMarker,n);return 'true' end end
if call('EXISTS',readyMarker)==1 then local expected=tonumber(call('GET',readyMarker)) local n=call('HLEN',runnableMeta)
if n==call('ZCARD',delayed)+call('ZCARD',ready) and (n>0 or expected==0) then call('SET',readyMarker,n);return 'true' end
call('DEL',readyMarker,readyCursor) end
if call('HLEN',runs)>10000 then return redis.error_reply('JOBS_INDEX_REBUILD_LIMIT_EXCEEDED') end
local storedCursor=call('GET',readyCursor)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0
if not storedCursor then call('DEL',ready,delayed,runnableMeta) end
repeat local page=call('HSCAN',runs,cursor,'COUNT',1);cursor=page[1]
for index=2,#page[2],2 do local id=page[2][index-1]
local raw=page[2][index]
local run=sd(raw) local runnable=run and run.id==id and (run.status=='queued' or run.status=='retryable')
and type(run.queue)=='string' and type(run.task)=='string' and type(run.runAt)=='number' and (run.priority==nil or type(run.priority)=='number') if runnable then call('ZADD',delayed,run.runAt,run.id)
call('HSET',runnableMeta,run.id,e(rui(run))) end
processed=processed+1;processedBytes=processedBytes+string.len(raw) end
until cursor=='0' or processed>=16 or processedBytes>=cap
if cursor=='0' then call('DEL',readyCursor)
call('SET',readyMarker,call('HLEN',runnableMeta))
return 'true' end
call('SET',readyCursor,cursor)
return 'false'
elseif op == 'claim' then
if call('EXISTS',readyMarker)==0 then return redis.error_reply('JOBS_READY_INDEX_REQUIRES_BACKFILL') end
erc() if call('ZCARD',delayed)>10000 then return redis.error_reply('JOBS_DELAYED_INDEX_LIMIT_EXCEEDED') end
local due = call('ZRANGEBYSCORE', delayed, '-inf', a.now, 'LIMIT', 0, 10000) for _,id in ipairs(due) do local info=ldr(id)
call('ZREM',delayed,id)
if info then if info.runAt<=a.now then local group=info.queue..':'..info.task
call('SADD',readyGroups,group)
call('ZADD',p..':ready:'..group,-(info.priority or 0),rm(info))
call('ZADD',ready,-(info.priority or 0),rm(info)) else call('ZADD',delayed,info.runAt,info.id) end
else call('HDEL',runnableMeta,id) end
end if call('ZCARD',ready)>10000 then return redis.error_reply('JOBS_READY_INDEX_LIMIT_EXCEEDED') end
local globalActive=tonumber(call('GET',runningCount) or '0')
local capacity=math.min(a.limit,math.max(0,a.maxConcurrentRuns-globalActive)) local allowedTasks=nil if a.allowedTasks then
allowedTasks={}
for _,task in ipairs(a.allowedTasks) do allowedTasks[task]=true end
end local claimed={}
local originals={}
local claimedBytes=0
local maxClaimBytes=60*1024*1024
local function rbc() for _,original in ipairs(originals) do local current=d(call('HGET',runs,original.id));lr(current);pr(original) end
end
for _,member in ipairs(call('ZRANGE',ready,0,-1)) do if #claimed>=capacity then break end
local id=rid(member)
local info=ldr(id) if info and info.runAt<=a.now and (not allowedTasks or allowedTasks[info.task]) then local taskLimit=a.concurrencyByTask and a.concurrencyByTask[info.task]
local taskActive=tonumber(call('HGET',runningTasks,info.task) or '0') if call('SISMEMBER',paused,info.queue)==0 and (not taskLimit or taskActive<taskLimit) then local runBytes=call('HSTRLEN',runs,id)
local run=runBytes<=cap and sd(call('HGET',runs,id)) or nil
if runBytes>cap then dr(id,info)
elseif run and not vrr(run,id) then
dr(id,info)
elseif not run or run.queue~=info.queue or run.task~=info.task or run.runAt~=info.runAt or (run.priority or 0)~=(info.priority or 0) then call('ZREM',ready,member)
call('HDEL',runnableMeta,id)
if run and (run.status=='queued' or run.status=='retryable') then call('ZADD',delayed,run.runAt,run.id)
call('HSET',runnableMeta,run.id,e(rui(run))) end
else local transitionAt=math.max(a.now,run.createdAt or 0,run.updatedAt or 0)
if transitionAt>99999999999999-a.leaseMs then rbc()
return redis.error_reply('JOBS_LEASE_TIMESTAMP_OVERFLOW') end
local original=d(e(run)) run.status='running'; run.attempt=(run.attempt or 0)+1; run.startedAt=run.startedAt or transitionAt; run.updatedAt=transitionAt
run.leaseOwner=a.workerId; run.leaseToken=redis.sha1hex(id..':'..a.workerId..':'..a.now..':'..a.leaseSeed); run.leaseExpiresAt=transitionAt+a.leaseMs; run.lastHeartbeatAt=transitionAt local encodedRun=e(run)
if claimedBytes+string.len(encodedRun)>maxClaimBytes then break end;claimedBytes=claimedBytes+string.len(encodedRun) table.insert(originals,original)
pr(run); call('INCR',runningCount); call('HINCRBY',runningTasks,run.task,1); table.insert(claimed,run) end
end
else call('ZREM',ready,member) if info and info.id==id then call('ZADD',delayed,info.runAt,info.id) else call('HDEL',runnableMeta,id) end
end end
call('SET',readyMarker,call('HLEN',runnableMeta))
return ea(claimed)
elseif op == 'releaseClaim' then local run=d(call('HGET',runs,a.id))
if not run or run.status~='running' or run.leaseToken~=a.token then return 'false' end
lr(run);run.attempt=(run.attempt or 1)-1;run.status=run.attempt==0 and 'queued' or 'retryable';run.updatedAt=math.max(a.now,run.createdAt or 0,run.updatedAt or 0)
if run.attempt==0 then run.startedAt=nil end;run.leaseOwner=nil;run.leaseToken=nil;run.leaseExpiresAt=nil;run.lastHeartbeatAt=nil;pr(run)
return 'true'
elseif op == 'discardClaim' then local run=sd(call('HGET',runs,a.id))
if not run or run.status~='running' or run.leaseToken~=a.token then return 'false' end
if call('SISMEMBER',p..':idx:status:running',a.id)==0 then return 'true' end
lr(run);rri(run);rsx(run)
return 'true'
elseif op == 'renew' then local run=d(call('HGET',runs,a.id)); if not run or run.status~='running' or run.leaseToken~=a.token or not run.leaseExpiresAt or run.leaseExpiresAt<=a.now then return 'false' end
run.leaseExpiresAt=math.max(run.leaseExpiresAt or 0,a.expiresAt); run.lastHeartbeatAt=math.max(run.lastHeartbeatAt or 0,a.now); run.updatedAt=math.max(run.updatedAt or 0,a.now); pr(run); return 'true'
elseif op == 'transition' then local current=d(call('HGET',runs,a.run.id)); if not current or current.status~='running' or current.leaseToken~=a.token or not current.leaseExpiresAt or current.leaseExpiresAt<=a.run.updatedAt then return 'false' end
if current.id~=a.run.id or current.task~=a.run.task or current.queue~=a.run.queue or current.createdAt~=a.run.createdAt or current.priority~=a.run.priority or current.attempt~=a.run.attempt or current.maxAttempts~=a.run.maxAttempts or current.scheduleId~=a.run.scheduleId or current.startedAt~=a.run.startedAt or current.idempotencyKey~=a.run.idempotencyKey or current.idempotencyExpiresAt~=a.run.idempotencyExpiresAt or current.idempotencyChecksum~=a.run.idempotencyChecksum or a.run.updatedAt<current.updatedAt or (a.run.status~='retryable' and current.runAt~=a.run.runAt) or not deq(current.payload,a.run.payload) or not deq(current.retryPolicy,a.run.retryPolicy) then return redis.error_reply('JOBS_RUN_IDENTITY_CHANGED') end
if a.dead and call('HEXISTS',dead,a.dead.id)==1 then return redis.error_reply('JOBS_DEAD_LETTER_ID_EXISTS') end
if a.dead and call('HGET',deadByRun,a.dead.runId) then return redis.error_reply('JOBS_DEAD_LETTER_RUN_EXISTS') end
if a.dead and call('HLEN',dead)>=10000 then return redis.error_reply('JOBS_DEAD_LETTER_LIMIT_EXCEEDED') end
lr(current); pr(a.run); if a.dead then pd(a.dead) end; return 'true'
elseif op == 'cancel' then local run=d(call('HGET',runs,a.id)); if not run or ts(run.status) or (a.token and run.leaseToken~=a.token) then return 'false' end
lr(run); local transitionAt=math.max(a.now,run.createdAt or 0,run.updatedAt or 0);run.status='cancelled'; run.cancelReason=a.reason; run.updatedAt=transitionAt; run.terminalAt=transitionAt;run.terminalExpiresAt=a.terminalExpiresAt and math.max(a.terminalExpiresAt,transitionAt) or nil run.leaseOwner=nil; run.leaseToken=nil; run.leaseExpiresAt=nil; run.lastHeartbeatAt=nil; pr(run); return 'true'
elseif op == 'rro' then if call('HLEN',dead)<10000 then return 'false' end
for _,id in ipairs(call('ZRANGEBYSCORE',leases,'-inf',a.now-a.recoveryAfterMs,'LIMIT',0,10000)) do local info=sd(call('HGET',rmeta,id))
if type(info)~='table' or not w(info.attempt,1,100) or not w(info.maxAttempts,1,100) or info.attempt<info.maxAttempts then return 'false' end end
return 'true'
elseif op == 'recover' then
local ids=call('ZRANGEBYSCORE',leases,'-inf',a.now-a.recoveryAfterMs,'LIMIT',0,10000) local eligible={}
local repairs={} local deadSlots=10000-call('HLEN',dead)
if deadSlots<0 then return redis.error_reply('JOBS_DEAD_LETTER_LIMIT_EXCEEDED') end
for _,id in ipairs(ids) do if #eligible>=1000 then break end
local bytes=call('HSTRLEN',runs,id)
local run=bytes<=cap and sd(call('HGET',runs,id)) or nil
local info=lda(id,run) if info and info.leaseExpiresAt<=a.now-a.recoveryAfterMs then local exhausted=(info.attempt or 0)>=(info.maxAttempts or 0)
local ordinal=#eligible+1 local deadId=exhausted and (a.recoverySeed..':'..tostring(ordinal)) or nil if exhausted and deadSlots==0 then
else if va(run,id) and run.leaseExpiresAt==info.leaseExpiresAt and run.attempt==info.attempt and run.maxAttempts==info.maxAttempts then if deadId and call('HEXISTS',dead,deadId)==1 then return redis.error_reply('JOBS_DEAD_LETTER_ID_EXISTS') end
if exhausted and call('HGET',deadByRun,run.id) then return redis.error_reply('JOBS_DEAD_LETTER_RUN_EXISTS') end
if exhausted then deadSlots=deadSlots-1 end
table.insert(eligible,{run=run,exhausted=exhausted,deadId=deadId})
else table.insert(repairs,{id=id,run=va(run,id) and run or nil,info=info}) end
end else table.insert(repairs,{id=id,run=va(run,id) and run or nil,info=info}) end
end for _,entry in ipairs(eligible) do local run=entry.run;lr(run)
local transitionAt=math.max(a.now,run.createdAt or 0,run.updatedAt or 0) run.status=entry.exhausted and 'dead-lettered' or 'retryable';run.runAt=transitionAt;run.updatedAt=transitionAt run.leaseOwner=nil;run.leaseToken=nil;run.leaseExpiresAt=nil;run.lastHeartbeatAt=nil
if entry.exhausted then run.failureCode='lease-expired';run.error='lease-expired';run.terminalAt=transitionAt;run.terminalExpiresAt=a.terminalExpiresAt and math.max(a.terminalExpiresAt,transitionAt) or nil local item={id=entry.deadId,runId=run.id,queue=run.queue,task=run.task,reason='lease-expired',error='lease-expired',attempts=run.attempt,failedAt=transitionAt,payload=run.payload}
pd(item) end
pr(run)
end for _,entry in ipairs(repairs) do call('ZREM',leases,entry.id)
call('HDEL',rmeta,entry.id)
if entry.run then call('ZADD',leases,entry.run.leaseExpiresAt,entry.id)
call('HSET',rmeta,entry.run.id,e(ri(entry.run)))
elseif entry.info then la(entry.info) end
end return tostring(#eligible)
elseif op == 'bso' then if call('EXISTS',scheduleOrderMarker)==1 then if not a.due then return 'true' end local n=tonumber(call('GET',sdm))
if n and n==call('ZCARD',scheduleDue)+call('ZCARD',scheduleProcessing) then return 'true' end
call('DEL',scheduleOrderMarker,scheduleOrderCursor) end
if call('HLEN',schedules)>10000 then return redis.error_reply('JOBS_SCHEDULE_LIMIT_EXCEEDED') end
local storedCursor=call('GET',scheduleOrderCursor)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0
if not storedCursor then call('DEL',sdr) end
repeat local page=call('HSCAN',schedules,cursor,'COUNT',1);cursor=page[1]
for index=2,#page[2],2 do local id=page[2][index-1]
local raw=page[2][index]
local schedule=sd(raw) if schedule and schedule.id==id and sid(schedule.task,128) and (schedule.queue==nil or sid(schedule.queue,64)) then asi(schedule)
if schedule.enabled~=false and w(schedule.nextRunAt,0,99999999999999) and not call('ZSCORE',scheduleProcessing,id) then local score=tonumber(call('ZSCORE',scheduleDue,id)) or schedule.nextRunAt
call('ZADD',sdr,math.max(score,schedule.nextRunAt),id) end
end
processed=processed+1;processedBytes=processedBytes+string.len(raw) end
until cursor=='0' or processed>=16 or processedBytes>=cap
if cursor=='0' then call('DEL',scheduleOrderCursor,scheduleDue)
if call('ZCARD',sdr)>0 then call('RENAME',sdr,scheduleDue) end
call('SET',scheduleOrderMarker,'1');ssd()
return 'true' end
call('SET',scheduleOrderCursor,cursor)
return 'false'
elseif op == 'saveSchedule' then local raw=call('HGET',schedules,a.schedule.id)
if a.expectedMode=='absent' and raw then return 'false' end
if a.expectedMode=='exact' then local current=sd(raw)
if not current or not deq(current,a.expected) then return 'false' end
end
if call('ZSCORE',scheduleProcessing,a.schedule.id) then return redis.error_reply('JOBS_SCHEDULE_BUSY') end
if not raw and call('HLEN',schedules)>=10000 then return redis.error_reply('JOBS_SCHEDULE_LIMIT_EXCEEDED') end; ps(a.schedule); call('ZREM',scheduleDue,a.schedule.id); if a.schedule.enabled~=false and a.schedule.nextRunAt then call('ZADD',scheduleDue,a.schedule.nextRunAt,a.schedule.id) end;ssd()
return 'true'
elseif op == 'setScheduleEnabled' then if call('ZSCORE',scheduleProcessing,a.id) then return redis.error_reply('JOBS_SCHEDULE_BUSY') end
local schedule=d(call('HGET',schedules,a.id)); if not schedule then return 'false' end
if a.expected and not deq(schedule,a.expected) then return 'false' end
schedule.enabled=a.enabled; if a.enabled then schedule.nextRunAt=a.nextRunAt end; ps(schedule); call('ZREM',scheduleDue,a.id); if schedule.enabled~=false and schedule.nextRunAt then call('ZADD',scheduleDue,schedule.nextRunAt,a.id) end;ssd()
return 'true'
elseif op == 'getSchedule' then return call('HGET',schedules,a.id)
elseif op == 'listSchedules' then if call('EXISTS',scheduleOrderMarker)==0 then return redis.error_reply('JOBS_SCHEDULE_INDEX_REQUIRES_BACKFILL') end
if call('HLEN',schedules)>10000 then return redis.error_reply('JOBS_SCHEDULE_LIMIT_EXCEEDED') end
local q=a.query or {}
local enabled=q.enabled==false and '0' or '1'
local queue=sc(q.queue)
local base=scheduleOrder if q.queue and q.task and q.enabled~=nil then base=p..':idx:schedule-queue-task-enabled-order:'..queue..':'..q.task..':'..enabled
elseif q.queue and q.task then base=p..':idx:schedule-queue-task-order:'..queue..':'..q.task
elseif q.queue and q.enabled~=nil then base=p..':idx:schedule-queue-enabled-order:'..queue..':'..enabled
elseif q.task and q.enabled~=nil then base=p..':idx:schedule-task-enabled-order:'..q.task..':'..enabled
elseif q.queue then base=p..':idx:schedule-queue-order:'..queue
elseif q.task then base=p..':idx:schedule-task-order:'..q.task
elseif q.enabled~=nil then base=p..':idx:schedule-enabled-order:'..enabled end
if call('ZCARD',base)>10000 then return redis.error_reply('JOBS_SCHEDULE_INDEX_LIMIT_EXCEEDED') end
local result={}
local offset=math.max(0,q.offset or 0)
local limit=math.min(1000,math.max(0,q.limit or 100))
local cursor=0
local matched=0
local resultBytes=0 while #result<limit do local pageSize=500
local ids=call('ZRANGE',base,cursor,cursor+pageSize-1)
if #ids==0 then break end
local retained=0 for _,id in ipairs(ids) do local value=call('HGET',schedules,id)
local schedule=d(value)
local valid=schedule and schedule.id==id and (not q.queue or schedule.queue==q.queue) and (not q.task or schedule.task==q.task) and (q.enabled==nil or (schedule.enabled~=false)==q.enabled)
if valid then if matched>=offset then if resultBytes+string.len(value)>60*1024*1024 then return ea(result) end;resultBytes=resultBytes+string.len(value)
table.insert(result,value) end
matched=matched+1;retained=retained+1
else call('ZREM',base,id) end
if #result>=limit then break end
end
if #ids<pageSize then break end;cursor=cursor+retained end
return ea(result)
elseif op == 'deleteSchedule' then if call('ZSCORE',scheduleProcessing,a.id) then return redis.error_reply('JOBS_SCHEDULE_BUSY') end; local schedule=d(call('HGET',schedules,a.id));rsi(schedule)
call('HDEL',schedules,a.id); call('ZREM',scheduleDue,a.id);ssd()
return 'true'
elseif op == 'claimSchedules' then if a.now>99999999999999-30000 then return redis.error_reply('JOBS_SCHEDULE_TIMESTAMP_OVERFLOW') end
local expired=call('ZRANGEBYSCORE',scheduleProcessing,'-inf',a.now,'LIMIT',0,100)
local expiredBytes=0 for _,id in ipairs(expired) do local bytes=call('HSTRLEN',schedules,id)
local raw=bytes<=cap and call('HGET',schedules,id) or nil
if bytes>cap then call('ZREM',scheduleProcessing,id)
call('HDEL',scheduleTokens,id)
call('HDEL',scheduleHashes,id)
elseif expiredBytes+bytes>cap then break else expiredBytes=expiredBytes+bytes
local schedule=sd(raw)
if schedule and schedule.enabled~=false and w(schedule.nextRunAt,0,99999999999999) then call('ZADD',scheduleDue,schedule.nextRunAt,id) end
call('ZREM',scheduleProcessing,id)
call('HDEL',scheduleTokens,id)
call('HDEL',scheduleHashes,id) end
end local ids=call('ZRANGEBYSCORE',scheduleDue,'-inf',a.now,'LIMIT',0,10000)
local allowedTasks=nil
if a.allowedTasks then allowedTasks={}
for _,task in ipairs(a.allowedTasks) do allowedTasks[task]=true end
end local allowedMisfire=nil
local allowedOverlap=nil if a.allowedMisfire then allowedMisfire={}
for _,value in ipairs(a.allowedMisfire) do allowedMisfire[value]=true end
end
if a.allowedOverlap then allowedOverlap={}
for _,value in ipairs(a.allowedOverlap) do allowedOverlap[value]=true end
end local result={}
local claimedBytes=0
local maxClaimBytes=cap for _,id in ipairs(ids) do
if #result>=100 then break end
local bytes=call('HSTRLEN',schedules,id)
local schedule=bytes<=maxClaimBytes and call('HGET',schedules,id) or nil
local decoded=sd(schedule)
local policy=type(decoded)=='table' and type(decoded.policy)=='table' and decoded.policy or {}
local misfire=policy.misfire or 'fire-once'
local overlap=policy.overlap or 'queue' if bytes>maxClaimBytes or not schedule or not decoded or decoded.id~=id then call('ZREM',scheduleDue,id)
elseif allowedTasks and not allowedTasks[decoded.task] then
elseif decoded.enabled==false or not w(decoded.nextRunAt,0,99999999999999) or decoded.nextRunAt>a.now then call('ZREM',scheduleDue,id)
elseif decoded.policy~=nil and type(decoded.policy)~='table' then call('ZREM',scheduleDue,id)
elseif misfire~='skip' and misfire~='fire-once' and misfire~='catch-up' then call('ZREM',scheduleDue,id)
elseif overlap~='queue' and overlap~='skip' and overlap~='allow' then call('ZREM',scheduleDue,id)
elseif allowedMisfire and not allowedMisfire[misfire] then
elseif allowedOverlap and not allowedOverlap[overlap] then
elseif claimedBytes+bytes>maxClaimBytes then break else claimedBytes=claimedBytes+bytes
call('ZREM',scheduleDue,id)
local token=redis.sha1hex(id..':'..a.now..':'..a.seed)
call('ZADD',scheduleProcessing,a.now+30000,id)
call('HSET',scheduleTokens,id,token)
call('HSET',scheduleHashes,id,redis.sha1hex(schedule))
table.insert(result,{id=id,schedule=schedule,token=token}) end
end ssd()
return ea(result)
elseif op == 'commitSchedules' then
local outcomeKey=p..':schedule-commit:'..a.batchId if call('GET',outcomeKey)=='done' then return 'true' end
local newIds={}
local scheduleIds={}
for _,commit in ipairs(a.commits or {}) do local id=commit.schedule.id if scheduleIds[id] or call('HGET',scheduleTokens,id)~=commit.token then return redis.error_reply('JOBS_SCHEDULE_LEASE_LOST') end
local current=call('HGET',schedules,id) if not current or call('HGET',scheduleHashes,id)~=redis.sha1hex(current) then return redis.error_reply('JOBS_SCHEDULE_CHANGED') end
local decodedCurrent=d(current)
if not decodedCurrent or decodedCurrent.id~=id then return redis.error_reply('JOBS_SCHEDULE_CHANGED') end
scheduleIds[id]=true for _,run in ipairs(commit.runs or {}) do if newIds[run.id] or call('HEXISTS',runs,run.id)==1 then return redis.error_reply('JOBS_RUN_ID_EXISTS') end
newIds[run.id]=true end
end
local newRunCount=0
for _ in pairs(newIds) do newRunCount=newRunCount+1 end
if call('HLEN',runs)+newRunCount>10000 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
local newQueues={}
local newQueueCount=0
for _,commit in ipairs(a.commits or {}) do for _,run in ipairs(commit.runs or {}) do if call('SISMEMBER',queues,run.queue)==0 and not newQueues[run.queue] then newQueues[run.queue]=true;newQueueCount=newQueueCount+1 end
end end
if call('SCARD',queues)+newQueueCount>1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
for _,commit in ipairs(a.commits or {}) do
local schedule=commit.schedule ps(schedule)
call('ZREM',scheduleProcessing,schedule.id)
call('HDEL',scheduleTokens,schedule.id)
call('HDEL',scheduleHashes,schedule.id) if schedule.enabled~=false and schedule.nextRunAt then call('ZADD',scheduleDue,commit.deferUntil or schedule.nextRunAt,schedule.id) end
for _,run in ipairs(commit.runs or {}) do pr(run) end
end call('SET',outcomeKey,'done','PX',60000)
ssd()
return 'true'
elseif op == 'releaseSchedule' then for _,claim in ipairs(a.claims or {a}) do if call('HGET',scheduleTokens,claim.id)==claim.token then
local schedule=sd(call('HGET',schedules,claim.id)); call('ZREM',scheduleProcessing,claim.id); call('HDEL',scheduleTokens,claim.id)
call('HDEL',scheduleHashes,claim.id) if not claim.discard and schedule and schedule.enabled~=false and schedule.nextRunAt then call('ZADD',scheduleDue,claim.deferUntil or schedule.nextRunAt,claim.id) end
end end
ssd()
return 'true'
elseif op == 'pause' then if a.value then if call('SISMEMBER',paused,a.queue)==0 and call('SCARD',paused)>=1000 then return redis.error_reply('JOBS_PAUSED_QUEUE_LIMIT_EXCEEDED') end
if call('SISMEMBER',queues,a.queue)==0 and call('SCARD',queues)>=1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
call('SADD',paused,a.queue)
call('SADD',queues,a.queue) else call('SREM',paused,a.queue)
if call('SCARD',p..':idx:queue:'..a.queue)==0 then call('SREM',queues,a.queue) end
end; return 'true'
elseif op == 'paused' then return e(call('SMEMBERS',paused))
elseif op == 'queueStats' then if not a.queue and call('SCARD',queues)>1000 then return redis.error_reply('JOBS_QUEUE_STATS_LIMIT_EXCEEDED') end
if call('EXISTS',queueStatsMarker)==0 then return redis.error_reply('JOBS_QUEUE_STATS_INDEX_REQUIRES_BACKFILL') end
local result={}
local names=a.queue and {a.queue} or call('SMEMBERS',queues)
for _,queue in ipairs(call('SMEMBERS',paused)) do local found=false
for _,name in ipairs(names) do if name==queue then found=true end
end
if not found and not a.queue then table.insert(names,queue) end
end
if #names>1000 then return redis.error_reply('JOBS_QUEUE_STATS_LIMIT_EXCEEDED') end
for _,queue in ipairs(names) do local stats={queue=queue,queued=tonumber(call('HGET',queueStatusCounts,queue..':queued') or '0'),running=tonumber(call('HGET',queueStatusCounts,queue..':running') or '0'),retryable=tonumber(call('HGET',queueStatusCounts,queue..':retryable') or '0'),deadLettered=tonumber(call('HGET',queueStatusCounts,queue..':dead-lettered') or '0'),completed=tonumber(call('HGET',queueStatusCounts,queue..':completed') or '0'),failed=tonumber(call('HGET',queueStatusCounts,queue..':failed') or '0'),cancelled=tonumber(call('HGET',queueStatusCounts,queue..':cancelled') or '0'),paused=call('SISMEMBER',paused,queue)==1,lagMs=0}
stats.lagMs=ql(queue,a.now)
table.insert(result,stats) end
return ea(result)
elseif op == 'bdi' then if call('EXISTS',deadIndexesMarker)==1 then local n=call('HLEN',dead)
if n==call('ZCARD',deadOrder) and n==call('HLEN',deadMeta) and n==call('HLEN',deadByRun) then return 'true' end
call('DEL',deadIndexesMarker,deadIndexesCursor) end
if call('HLEN',dead)>10000 then return redis.error_reply('JOBS_DEAD_LETTER_LIMIT_EXCEEDED') end
local storedCursor=call('GET',deadIndexesCursor)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0 if not storedCursor then call('DEL',deadMeta,deadOrder,deadByRun) end
repeat
local page=call('HSCAN',dead,cursor,'COUNT',1);cursor=page[1] for index=1,#page[2],2 do local key=page[2][index]
local raw=page[2][index+1]
local item=sd(raw)
local existing=item and item.runId and call('HGET',deadByRun,item.runId) or nil if item and item.id==key and item.runId and (not existing or existing==key) then pd(item) end
processed=processed+1;processedBytes=processedBytes+string.len(raw)
end until cursor=='0' or processed>=16 or processedBytes>=cap if cursor=='0' then call('DEL',deadIndexesCursor)
call('SET',deadOrderMarker,'1')
call('SET',deadIndexesMarker,'1')
return 'true' end
call('SET',deadIndexesCursor,cursor)
return 'false'
elseif op == 'bti' then if call('EXISTS',tmk)==1 then local n=tonumber(call('GET',tmk))
if n and n==call('ZCARD',terminal) then return 'true' end
call('DEL',tmk,tcur) end
if call('HLEN',runs)>10000 then return redis.error_reply('JOBS_INDEX_REBUILD_LIMIT_EXCEEDED') end
local storedCursor=call('GET',tcur)
local cursor=storedCursor or '0'
local processed=0
local processedBytes=0
if not storedCursor then call('DEL',terminal) end
repeat
local page=call('HSCAN',runs,cursor,'COUNT',1);cursor=page[1] for index=2,#page[2],2 do local id=page[2][index-1]
local raw=page[2][index]
local run=sd(raw)
if run and run.id==id and ts(run.status) and run.terminalExpiresAt then call('ZADD',terminal,run.terminalExpiresAt,run.id) end;processed=processed+1;processedBytes=processedBytes+string.len(raw) end
until cursor=='0' or processed>=16 or processedBytes>=cap
if cursor=='0' then call('DEL',tcur)
call('SET',tmk,call('ZCARD',terminal))
return 'true' end
call('SET',tcur,cursor)
return 'false'
elseif op == 'listDead' then
if call('EXISTS',deadIndexesMarker)==0 then return redis.error_reply('JOBS_DEAD_INDEX_REQUIRES_BACKFILL') end
local result={}
local resultBytes=0
local limit=math.min(10000,math.max(0,a.limit or 10000))
if limit==0 then return ea(result) end
for _,id in ipairs(call('ZRANGE',deadOrder,0,limit-1)) do local value=call('HGET',deadMeta,id)
if value then resultBytes=resultBytes+string.len(value)
if resultBytes>60*1024*1024 then return redis.error_reply('JOBS_DEAD_SUMMARY_RESULT_TOO_LARGE') end
table.insert(result,value)
elseif call('HEXISTS',dead,id)==0 then call('ZREM',deadOrder,id) else return redis.error_reply('JOBS_DEAD_METADATA_MISSING') end
end
return ea(result)
elseif op == 'getDead' then return call('HGET',dead,a.id)
elseif op == 'countDead' then return tostring(call('HLEN',dead))
elseif op == 'deleteDead' then local item=d(call('HGET',dead,a.id))
if not item then return 'true' end
local source=d(call('HGET',runs,item.runId))
if item.id~=a.id or not source or source.id~=item.runId or source.status~='dead-lettered' or source.queue~=item.queue or source.task~=item.task or source.attempt~=item.attempts then return redis.error_reply('JOBS_DEAD_LETTER_RELATIONSHIP_INVALID') end;ridc(item.runId,nil);rd(item,a.id);rri(source);rsx(source)
call('HDEL',runs,item.runId)
return 'true'
elseif op == 'requeueDead' then
local rawItem=call('HGET',dead,a.id)
local item=d(rawItem)
if not item then return nil end
if item.id~=a.id then return redis.error_reply('JOBS_DEAD_LETTER_RELATIONSHIP_INVALID') end
if redis.sha1hex(rawItem)~=a.deadToken then return redis.error_reply('JOBS_DEAD_LETTER_CHANGED') end
if call('HEXISTS',runs,a.run.id)==1 then return redis.error_reply('JOBS_RUN_ID_EXISTS') end
local source=d(call('HGET',runs,item.runId)) if not source or source.id~=item.runId or source.status~='dead-lettered' or source.queue~=item.queue or source.task~=item.task or source.attempt~=item.attempts then return redis.error_reply('JOBS_DEAD_LETTER_RELATIONSHIP_INVALID') end
local idempotencyCount=call('HLEN',idem)
if idempotencyCount>10000 then return redis.error_reply('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
local replacementFreesIdempotency=hrid(item.runId,a.idempotency and a.idempotency.key or nil) if call('SISMEMBER',queues,a.run.queue)==0 and call('SCARD',queues)>=1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end
if a.idempotency then local existing=d(call('HGET',idem,a.idempotency.key)) if existing and existing.expiresAt>a.run.createdAt then return redis.error_reply('JOBS_DEAD_REQUEUE_IDEMPOTENCY_CONFLICT') end
if not existing and idempotencyCount>=10000 and not replacementFreesIdempotency then return redis.error_reply('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
end pr(a.run)
ridc(item.runId,a.idempotency and a.idempotency.key or nil) if a.idempotency then local record=a.idempotency;record.runId=a.run.id
call('HSET',idem,record.key,e(record))
call('ZADD',idemExpiry,record.expiresAt,record.key) end
rri(source);rsx(source)
call('HDEL',runs,item.runId);rd(item,a.id)
return e(a.run)
elseif op == 'triggerNow' then if call('ZSCORE',scheduleProcessing,a.id) then return redis.error_reply('JOBS_SCHEDULE_BUSY') end
local current=call('HGET',schedules,a.id)
if not current then return '[]' end
if redis.sha1hex(current)~=a.scheduleToken then return redis.error_reply('JOBS_SCHEDULE_CHANGED') end
if call('HEXISTS',runs,a.run.id)==1 then return redis.error_reply('JOBS_RUN_ID_EXISTS') end
if call('HLEN',runs)>=10000 then return redis.error_reply('JOBS_RUN_LIMIT_EXCEEDED') end
if call('SISMEMBER',queues,a.run.queue)==0 and call('SCARD',queues)>=1000 then return redis.error_reply('JOBS_QUEUE_LIMIT_EXCEEDED') end; pr(a.run); return ea({a.run})
elseif op == 'cleanup' then if call('EXISTS',tmk)==0 then return redis.error_reply('JOBS_TERMINAL_INDEX_REQUIRES_BACKFILL') end
if call('EXISTS',deadIndexesMarker)==0 then return redis.error_reply('JOBS_DEAD_INDEX_REQUIRES_BACKFILL') end
local ic=call('HLEN',idem)
if ic>10000 then return redis.error_reply('JOBS_IDEMPOTENCY_LIMIT_EXCEEDED') end
local rebuild=ic~=call('ZCARD',idemExpiry) local selected,stale,quarantined={},{},{} local candidates=call('ZRANGEBYSCORE',terminal,'-inf',a.now,'LIMIT',0,10000) local protected={}
if rebuild or #candidates>0 then local entries=call('HGETALL',idem)
if rebuild then call('DEL',idemExpiry) end
for index=1,#entries,2 do local claim=sd(entries[index+1])
if not validI(claim) then return redis.error_reply('JOBS_IDEMPOTENCY_RECORD_INVALID') end
if rebuild then call('ZADD',idemExpiry,claim.expiresAt,entries[index]) end
if #candidates>0 and claim.expiresAt>a.now then protected[claim.runId]=true end end end
for _,id in ipairs(candidates) do
if #selected>=a.limit then break end
local run=sd(call('HGET',runs,id)) if not run or run.id~=id or not ts(run.status) or not run.terminalExpiresAt or run.terminalExpiresAt>a.now then
table.insert(stale,id)
elseif not protected[id] then local linked=nil
if run.status=='dead-lettered' then local deadId=call('HGET',deadByRun,id)
local item=sd(deadId and call('HGET',dead,deadId) or nil) if not deadId or not item or deadId~=item.id or item.runId~=run.id or item.queue~=run.queue or item.task~=run.task or item.attempts~=run.attempt then
table.insert(quarantined,id) else linked={key=deadId,item=item} end
end
if run.status~='dead-lettered' or linked then table.insert(selected,{id=id,run=run,dead=linked}) end
end end
local remaining=a.limit-#selected local expiredKeys,staleKeys,activeClaims={},{},{} if remaining>0 then
for _,key in ipairs(call('ZRANGEBYSCORE',idemExpiry,'-inf',a.now,'LIMIT',0,remaining)) do local raw=call('HGET',idem,key) if not raw then table.insert(staleKeys,key) else
local claim=sd(raw) if not validI(claim) then return redis.error_reply('JOBS_IDEMPOTENCY_RECORD_INVALID') end
if claim.expiresAt<=a.now then table.insert(expiredKeys,key) else table.insert(activeClaims,{key=key,expiresAt=claim.expiresAt}) end
end end
end
for _,id in ipairs(stale) do call('ZREM',terminal,id) end
for _,id in ipairs(quarantined) do call('ZREM',terminal,id) end
for _,entry in ipairs(selected) do
if entry.dead then rd(entry.dead.item,entry.dead.key) end
rri(entry.run);rsx(entry.run)
call('HDEL',runs,entry.id) end
for _,key in ipairs(staleKeys) do call('ZREM',idemExpiry,key) end
for _,claim in ipairs(activeClaims) do call('ZADD',idemExpiry,claim.expiresAt,claim.key) end
for _,key in ipairs(expiredKeys) do call('HDEL',idem,key)
call('ZREM',idemExpiry,key) end
return tostring(#selected+#expiredKeys) end
return redis.error_reply('JOBS_UNKNOWN_OPERATION')
`
