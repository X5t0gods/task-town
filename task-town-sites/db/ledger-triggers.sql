CREATE TRIGGER children_limit BEFORE INSERT ON children
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM children WHERE family_id=NEW.family_id)>=20
    THEN RAISE(ABORT,'child_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger
BEGIN
  UPDATE children SET balance=balance+NEW.delta WHERE id=NEW.child_id;
END;
--> statement-breakpoint
CREATE TRIGGER run_award AFTER UPDATE OF status ON runs
WHEN OLD.status='submitted' AND NEW.status='approved'
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,t.reward,c.balance+t.reward,
      'task_reward',NEW.id,'完成任务：'||t.title,NEW.reviewed_at
    FROM tasks t JOIN children c ON c.id=NEW.child_id WHERE t.id=NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER redemption_charge AFTER INSERT ON redemptions
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,-NEW.price,c.balance-NEW.price,
      'redemption',NEW.id,'申请兑换：'||NEW.title,NEW.created_at
    FROM children c WHERE c.id=NEW.child_id;
END;
--> statement-breakpoint
CREATE TRIGGER redemption_refund AFTER UPDATE OF status ON redemptions
WHEN OLD.status='pending' AND NEW.status='rejected'
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,NEW.price,c.balance+NEW.price,
      'redemption_refund',NEW.id,'退还星星：'||NEW.title,NEW.reviewed_at
    FROM children c WHERE c.id=NEW.child_id;
END;
