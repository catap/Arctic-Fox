/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=8 et :
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/layers/RemoteContentController.h"

#include "base/message_loop.h"
#include "base/task.h"
#include "MainThreadUtils.h"
#include "mozilla/dom/ContentParent.h"
#include "mozilla/dom/TabParent.h"
#include "mozilla/layers/APZCTreeManager.h"
#include "mozilla/layers/APZThreadUtils.h"
#include "mozilla/layers/CompositorBridgeParent.h"
#include "mozilla/layout/RenderFrameParent.h"
#include "mozilla/unused.h"
#include "Units.h"
#ifdef MOZ_WIDGET_ANDROID
#include "AndroidBridge.h"
#endif

namespace mozilla {
namespace layers {

RemoteContentController::RemoteContentController(uint64_t aLayersId,
                                                 dom::TabParent* aBrowserParent)
  : mUILoop(MessageLoop::current())
  , mLayersId(aLayersId)
  , mBrowserParent(aBrowserParent)
  , mMutex("RemoteContentController")
{
  MOZ_ASSERT(NS_IsMainThread());
}

RemoteContentController::~RemoteContentController()
{
  if (mBrowserParent) {
    Unused << PAPZParent::Send__delete__(this);
  }
}

void
RemoteContentController::RequestContentRepaint(const FrameMetrics& aFrameMetrics)
{
  MOZ_ASSERT(NS_IsMainThread());
  if (CanSend()) {
    Unused << SendUpdateFrame(aFrameMetrics);
  }
}

void
RemoteContentController::RequestFlingSnap(const FrameMetrics::ViewID& aScrollId,
                                          const mozilla::CSSPoint& aDestination)
{
  if (MessageLoop::current() != mUILoop) {
    // We have to send this message from the "UI thread" (main
    // thread).
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::RequestFlingSnap,
                        aScrollId, aDestination));
    return;
  }
  if (CanSend()) {
    Unused << SendRequestFlingSnap(aScrollId, aDestination);
  }
}

void
RemoteContentController::AcknowledgeScrollUpdate(const FrameMetrics::ViewID& aScrollId,
                                                 const uint32_t& aScrollGeneration)
{
  if (MessageLoop::current() != mUILoop) {
    // We have to send this message from the "UI thread" (main
    // thread).
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::AcknowledgeScrollUpdate,
                        aScrollId, aScrollGeneration));
    return;
  }
  if (CanSend()) {
    Unused << SendAcknowledgeScrollUpdate(aScrollId, aScrollGeneration);
  }
}

void
RemoteContentController::HandleDoubleTap(const CSSPoint& aPoint,
                                         Modifiers aModifiers,
                                         const ScrollableLayerGuid& aGuid)
{
  if (MessageLoop::current() != mUILoop) {
    // We have to send this message from the "UI thread" (main
    // thread).
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::HandleDoubleTap,
                        aPoint, aModifiers, aGuid));
    return;
  }
  if (CanSend()) {
    Unused << SendHandleDoubleTap(mBrowserParent->AdjustTapToChildWidget(aPoint),
            aModifiers, aGuid);
  }
}

void
RemoteContentController::HandleSingleTap(const CSSPoint& aPoint,
                                         Modifiers aModifiers,
                                         const ScrollableLayerGuid& aGuid)
{
  if (MessageLoop::current() != mUILoop) {
    // We have to send this message from the "UI thread" (main
    // thread).
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::HandleSingleTap,
                        aPoint, aModifiers, aGuid));
    return;
  }

  bool callTakeFocusForClickFromTap;
  layout::RenderFrameParent* frame;
  if (mBrowserParent && (frame = mBrowserParent->GetRenderFrame()) &&
      mLayersId == frame->GetLayersId()) {
    // Avoid going over IPC and back for calling TakeFocusForClickFromTap,
    // since the right RenderFrameParent is living in this process.
    frame->TakeFocusForClickFromTap();
    callTakeFocusForClickFromTap = false;
  } else {
    callTakeFocusForClickFromTap = true;
  }

  if (CanSend()) {
    Unused << SendHandleSingleTap(mBrowserParent->AdjustTapToChildWidget(aPoint),
            aModifiers, aGuid, callTakeFocusForClickFromTap);
  }
}

void
RemoteContentController::HandleLongTap(const CSSPoint& aPoint,
                                       Modifiers aModifiers,
                                       const ScrollableLayerGuid& aGuid,
                                       uint64_t aInputBlockId)
{
  if (MessageLoop::current() != mUILoop) {
    // We have to send this message from the "UI thread" (main
    // thread).
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::HandleLongTap,
                        aPoint, aModifiers, aGuid, aInputBlockId));
    return;
  }
  if (CanSend()) {
    Unused << SendHandleLongTap(mBrowserParent->AdjustTapToChildWidget(aPoint),
            aModifiers, aGuid, aInputBlockId);
  }
}

void
RemoteContentController::PostDelayedTask(Task* aTask, int aDelayMs)
{
#ifdef MOZ_ANDROID_APZ
  AndroidBridge::Bridge()->PostTaskToUiThread(aTask, aDelayMs);
#else
  (MessageLoop::current() ? MessageLoop::current() : mUILoop)->
     PostDelayedTask(FROM_HERE, aTask, aDelayMs);
#endif
}

bool
RemoteContentController::GetTouchSensitiveRegion(CSSRect* aOutRegion)
{
  MutexAutoLock lock(mMutex);
  if (mTouchSensitiveRegion.IsEmpty()) {
    return false;
  }

  *aOutRegion = CSSRect::FromAppUnits(mTouchSensitiveRegion.GetBounds());
  return true;
}

void
RemoteContentController::NotifyAPZStateChange(const ScrollableLayerGuid& aGuid,
                                              APZStateChange aChange,
                                              int aArg)
{
  if (MessageLoop::current() != mUILoop) {
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::NotifyAPZStateChange,
                        aGuid, aChange, aArg));
    return;
  }
  if (CanSend()) {
    Unused << SendNotifyAPZStateChange(aGuid.mScrollId, aChange, aArg);
  }
}

void
RemoteContentController::NotifyMozMouseScrollEvent(const FrameMetrics::ViewID& aScrollId,
                                                   const nsString& aEvent)
{
  if (MessageLoop::current() != mUILoop) {
    mUILoop->PostTask(
      FROM_HERE,
      NewRunnableMethod(this, &RemoteContentController::NotifyMozMouseScrollEvent,
                        aScrollId, aEvent));
    return;
  }

  if (mBrowserParent) {
    Unused << mBrowserParent->SendMouseScrollTestEvent(mLayersId, aScrollId, aEvent);
  }
}

void
RemoteContentController::NotifyFlushComplete()
{
  MOZ_ASSERT(NS_IsMainThread());
  if (CanSend()) {
    Unused << SendNotifyFlushComplete();
  }
}

bool
RemoteContentController::RecvUpdateHitRegion(const nsRegion& aRegion)
{
  MutexAutoLock lock(mMutex);
  mTouchSensitiveRegion = aRegion;
  return true;
}

bool
RemoteContentController::RecvZoomToRect(const uint32_t& aPresShellId,
                                        const ViewID& aViewId,
                                        const CSSRect& aRect,
                                        const uint32_t& aFlags)
{
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    apzcTreeManager->ZoomToRect(ScrollableLayerGuid(mLayersId, aPresShellId, aViewId),
                                aRect, aFlags);
  }
  return true;
}

bool
RemoteContentController::RecvContentReceivedInputBlock(const ScrollableLayerGuid& aGuid,
                                                       const uint64_t& aInputBlockId,
                                                       const bool& aPreventDefault)
{
  if (aGuid.mLayersId != mLayersId) {
    // Guard against bad data from hijacked child processes
    NS_ERROR("Unexpected layers id in RecvContentReceivedInputBlock; dropping message...");
    return false;
  }
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    APZThreadUtils::RunOnControllerThread(NewRunnableMethod(
        apzcTreeManager.get(), &APZCTreeManager::ContentReceivedInputBlock,
        aInputBlockId, aPreventDefault));
  }
  return true;
}

bool
RemoteContentController::RecvStartScrollbarDrag(const AsyncDragMetrics& aDragMetrics)
{
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    ScrollableLayerGuid guid(mLayersId, aDragMetrics.mPresShellId,
                             aDragMetrics.mViewId);

    APZThreadUtils::RunOnControllerThread(
      NewRunnableMethod(apzcTreeManager.get(),
                        &APZCTreeManager::StartScrollbarDrag,
                        guid, aDragMetrics));
  }
  return true;
}

bool
RemoteContentController::RecvSetTargetAPZC(const uint64_t& aInputBlockId,
                                           nsTArray<ScrollableLayerGuid>&& aTargets)
{
  for (size_t i = 0; i < aTargets.Length(); i++) {
    if (aTargets[i].mLayersId != mLayersId) {
      // Guard against bad data from hijacked child processes
      NS_ERROR("Unexpected layers id in SetTargetAPZC; dropping message...");
      return false;
    }
  }
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    // need a local var to disambiguate between the SetTargetAPZC overloads.
    void (APZCTreeManager::*setTargetApzcFunc)(uint64_t, const nsTArray<ScrollableLayerGuid>&)
        = &APZCTreeManager::SetTargetAPZC;
    APZThreadUtils::RunOnControllerThread(NewRunnableMethod(
        apzcTreeManager.get(), setTargetApzcFunc,
        aInputBlockId, aTargets));
  }
  return true;
}

bool
RemoteContentController::RecvSetAllowedTouchBehavior(const uint64_t& aInputBlockId,
                                                     nsTArray<TouchBehaviorFlags>&& aFlags)
{
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    APZThreadUtils::RunOnControllerThread(NewRunnableMethod(
        apzcTreeManager.get(), &APZCTreeManager::SetAllowedTouchBehavior,
        aInputBlockId, Move(aFlags)));
  }
  return true;
}

bool
RemoteContentController::RecvUpdateZoomConstraints(const uint32_t& aPresShellId,
                                                   const ViewID& aViewId,
                                                   const MaybeZoomConstraints& aConstraints)
{
  if (RefPtr<APZCTreeManager> apzcTreeManager = GetApzcTreeManager()) {
    apzcTreeManager->UpdateZoomConstraints(ScrollableLayerGuid(mLayersId, aPresShellId, aViewId),
                                           aConstraints);
  }
  return true;
}

void
RemoteContentController::ActorDestroy(ActorDestroyReason aWhy)
{
  {
    MutexAutoLock lock(mMutex);
    mApzcTreeManager = nullptr;
  }
  mBrowserParent = nullptr;
}

// TODO: Remove once upgraded to GCC 4.8+ on linux. Calling a static member
//       function (like PAPZParent::Send__delete__) in a lambda leads to a bogus
//       error: "'this' was not captured for this lambda function".
//
//       (see https://gcc.gnu.org/bugzilla/show_bug.cgi?id=51494)
static void
DeletePAPZParent(PAPZParent* aPAPZ)
{
  Unused << PAPZParent::Send__delete__(aPAPZ);
}

void
RemoteContentController::Destroy()
{
  RefPtr<RemoteContentController> controller = this;
  NS_DispatchToMainThread(NS_NewRunnableFunction([controller] {
    if (controller->CanSend()) {
      DeletePAPZParent(controller);
    }
  }));
}

void
RemoteContentController::ChildAdopted()
{
  // Clear the cached APZCTreeManager.
  MutexAutoLock lock(mMutex);
  mApzcTreeManager = nullptr;
}

already_AddRefed<APZCTreeManager>
RemoteContentController::GetApzcTreeManager()
{
  // We can't get a ref to the APZCTreeManager until after the child is
  // created and the static getter knows which CompositorBridgeParent is
  // instantiated with this layers ID. That's why try to fetch it when
  // we first need it and cache the result.
  MutexAutoLock lock(mMutex);
  if (!mApzcTreeManager) {
    mApzcTreeManager = CompositorBridgeParent::GetAPZCTreeManager(mLayersId);
  }
  RefPtr<APZCTreeManager> apzcTreeManager(mApzcTreeManager);
  return apzcTreeManager.forget();
}

} // namespace layers
} // namespace mozilla
