#!/usr/bin/env bash
# Pseudo training run: one metric line per step, then a final eval metric.
# Stands in for a job whose wall-clock time dwarfs the agent's reasoning time.
set -u
STEPS=${1:-40}
DELAY=${2:-3}
for i in $(seq 1 "$STEPS"); do
	loss=$(awk "BEGIN{printf \"%.4f\", 2.0/(1+$i*0.1)}")
	echo "step=$i/$STEPS loss=$loss"
	sleep "$DELAY"
done
echo "eval_loss=0.1234"
echo "training complete"
