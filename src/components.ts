/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineComponents } from '@iwsdk/core';
import { Robot } from './robot-component.js';
import { Target } from './target-component.js';
import { Ball } from './ball-component.js';

export default defineComponents([Robot, Target, Ball]);
