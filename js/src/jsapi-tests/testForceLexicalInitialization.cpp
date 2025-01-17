/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "jsapi-tests/tests.h"
#include "vm/ScopeObject.h"
#include "jsfriendapi.h"

BEGIN_TEST(testForceLexicalInitialization)
{
    // Attach an uninitialized lexical to a scope and ensure that it's
    // set to undefined
    RootedGlobalObject g(cx, cx->global());
    Rooted<ClonedBlockObject*> scope(cx, ClonedBlockObject::createGlobal(cx, g));

    RootedValue uninitialized(cx, MagicValue(JS_UNINITIALIZED_LEXICAL));
    RootedPropertyName name(cx, Atomize(cx, "foopi", 4)->asPropertyName());
    RootedId id(cx, NameToId(name));
    unsigned attrs = JSPROP_ENUMERATE | JSPROP_PERMANENT;

    NativeDefineProperty(cx, scope, id, uninitialized, nullptr, nullptr, attrs);

    // Verify that "foopi" is uninitialized
    const Value v = scope->getSlot(scope->lookup(cx, id)->slot());
    CHECK(v.isMagic(JS_UNINITIALIZED_LEXICAL));

    ForceLexicalInitialization(cx, scope);

    // Verify that "foopi" has been initialized to undefined
    const Value v2 = scope->getSlot(scope->lookup(cx, id)->slot());
    CHECK(v2.isUndefined());

    return true;
}
END_TEST(testForceLexicalInitialization)
